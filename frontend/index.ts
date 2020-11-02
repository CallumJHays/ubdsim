import { encode, decode, decodeAsync } from "@msgpack/msgpack";
import * as d3 from "d3";
import { timeThursday } from "d3";
import { sliderBottom } from "d3-simple-slider";

import "./style.scss";

const NO_CHOSEN_NODE = "None";

type Param<T> = {
  name: string;
  id: number;
  val: T;
};

type NumParam<T = number> = Param<T> & {
  min: number;
  max: number;
  log_scale: boolean;
  step?: number;
};

type VecParam = NumParam<number[]> & {
  min: number[];
  max: number[];
};

type EnumParam<T extends number | number[] | string | boolean> = Param<T> & {
  oneof: T[];
};

// hyperparams do actually have a value, but we don't use it on the frontend
type HyperParam = Param<null> & {
  id: number;
  params: { [attr: string]: AnyParam };
  hidden: string[];
};

type AnyParam =
  | Param<any>
  | NumParam<number>
  | VecParam
  | EnumParam<any>
  | HyperParam;

const state: {
  availableNodes: string[];
  chosenNode: string;
  id2param: { [id: number]: AnyParam };
  id2paramEditor: { [id: number]: ParamEditor<AnyParam> };
} = {
  availableNodes: [],
  chosenNode: NO_CHOSEN_NODE,
  id2param: {},
  id2paramEditor: {},
};

const nodePicker = document.getElementById("nodes") as HTMLSelectElement;
nodePicker.oninput = (e) =>
  setChosenNode((e.target as HTMLSelectElement).value);

const container = d3.select("#tuner");

const ws = new WebSocket(
  "ws://" + document.domain + ":" + location.port + "/ws"
);

ws.onmessage = async ({ data }) => {
  try {
    // check first to see if this is a json message with an updated availableNodes
    console.log("data", data);
    const { availableNodes } = JSON.parse(data);
    console.log("got available nodes", availableNodes);
    setAvailableNodes(availableNodes);

    // conect to the first available node
    // TODO: do better here
    setChosenNode(availableNodes[0]);

    if (!state.availableNodes.includes(state.chosenNode)) {
      setChosenNode(NO_CHOSEN_NODE);
    }
  } catch (err) {
    if (err instanceof SyntaxError) {
      const msg = await decodeFromBlob(data);
      console.log("got binary data", msg);

      // if we're awaiting param definitions
      if (
        state.chosenNode !== NO_CHOSEN_NODE &&
        Object.keys(state.id2param).length === 0 // if there are no  params in the map currently
      ) {
        setParams(msg as AnyParam[]);
      } else if (Array.isArray(msg)) {
        // gui reconstruction callback]
        const params = msg as AnyParam[];
        updateID2Param(params);

        for (const def of msg as AnyParam[]) {
          const editor = state.id2paramEditor[def.id];
          editor.param = def;
          editor.reconstructGui();
        }
      } else {
        console.error(
          "unexpected msg from server:",
          msg,
          "while in state",
          state
        );
        debugger;
      }
    }
  }
};

function setAvailableNodes(newNodes: string[]) {
  nodePicker.innerHTML = [...newNodes, NO_CHOSEN_NODE]
    .map((node) => `<option value="${node}">${node}</option>`)
    .join("");
  nodePicker.value = state.chosenNode;
  state.availableNodes = newNodes;
}

function setChosenNode(chosenNode: string) {
  // if it actually changed
  if (state.chosenNode !== chosenNode) {
    state.chosenNode = chosenNode;
    nodePicker.value = state.chosenNode;

    ws.send(JSON.stringify({ chosenNode }));

    setParams([]); // clear existing param id2paramEditor
  }
}

function setParams(params: AnyParam[]) {
  state.id2param = {};
  updateID2Param(params);

  container
    .selectAll("*")
    .remove()
    .data(params) // populate with new controls
    .enter()
    .append((param: AnyParam): any => createParamControl(param).el.node());
}

function updateID2Param(params: AnyParam[]) {
  for (const param of params) {
    state.id2param[param.id] = param;
    if ("params" in param) {
      // recurse through hyperparameters
      updateID2Param(Object.values(param.params));
    }
  }
}

function createParamControl(param: AnyParam) {
  const editor =
    "params" in param
      ? new HyperParamEditor(param)
      : "oneof" in param
      ? new EnumParamEditor(param)
      : "max" in param
      ? typeof param.val === "number"
        ? new NumParamEditor(param as NumParam<number>)
        : new VecParamEditor(param as VecParam)
      : typeof param.val === "boolean"
      ? new BoolParamEditor(param)
      : typeof param.val === "string"
      ? new StringParamEditor(param)
      : null;

  if (!editor) {
    console.error(param);
    throw new Error(`no editor found for param ^`);
  }
  return editor;
}

type D3Div = d3.Selection<HTMLDivElement, unknown, HTMLElement, undefined>;

abstract class ParamEditor<T extends Param<any>> {
  param: T;
  el: D3Div;

  constructor(param: T, insertLabel = true) {
    this.param = param;
    this.el = d3.create("div").classed("param-editor", true);
    if (insertLabel) {
      this.el.append("label").html(param.name.replace(" ", "<br />"));
    }
    state.id2paramEditor[param.id] = this;
    this.setup();
  }

  setParamVal(val: T["val"]) {
    this.param.val = val;
    // TODO: send value update over websocket
    ws.send(encode([this.param.id, val]));
    console.log("setting param", this.param, "to val", val);
  }

  // modify element to reflect new value
  // TODO: make abstract once impld
  onParamChange(val: T): void {}

  reconstructGui() {
    this.el.selectAll("*").remove();
    this.setup();
  }

  abstract setup(): void;
}

class BoolParamEditor extends ParamEditor<Param<boolean>> {
  setup() {
    this.el
      .append("input")
      .attr("type", "checkbox")
      .attr("checked", () => (this.param.val ? "" : null))
      .on("change", (e: any) => this.setParamVal(e.target.checked));
  }
}

class StringParamEditor extends ParamEditor<Param<string>> {
  setup() {
    // TODO: input
    throw new Error("TextEditor not implemented yet!");
  }
}

class EnumParamEditor extends ParamEditor<
  EnumParam<number | number[] | string | boolean>
> {
  setup() {
    this.el
      .append("select")
      .on("change", (e: any) =>
        this.setParamVal(this.param.oneof[e.target.value])
      )
      .selectAll()
      .data(this.param.oneof)
      .enter() // for each element of this.param.oneof
      .append("option")
      .text((option) => option.toString())
      .attr("value", (_, idx) => idx)
      .attr("selected", (option) => (option === this.param.val ? "" : null));
  }
}

class NumParamEditor extends ParamEditor<NumParam> {
  setVal: this["setParamVal"];

  constructor(
    param: NumParam,
    insertLabel = true,
    setVal: NumParamEditor["setVal"] = null
  ) {
    super(param, insertLabel);
    this.setVal = setVal ?? this.setParamVal;
  }

  setup() {
    const { val, min, max, log_scale, step } = this.param;

    this.el
      .append("svg")
      .style("display", "inline-block")
      .attr("width", 230)
      .attr("height", 47)
      .append("g")
      .attr("transform", "translate(12, 6)")
      .call(
        sliderBottom((log_scale ? d3.scaleLog : d3.scaleLinear)([min, max]))
          // @ts-ignore
          .default(val) // @types/d3-simple-slider missing this, max and default - HOW!?
          .min(min)
          .max(max)
          .ticks(4)
          .default(val)
          .step(step)
          .width(200)
          .on("onchange", (val: number) => {
            label.text(formatNum(val));
            this.setVal(val);
          })
      );

    const label = this.el
      .append("label")
      .classed("slider-val", true)
      .text(formatNum(val));
  }
}

abstract class CollapsibleParamEditor<T extends Param<any>> extends ParamEditor<
  T
> {
  active: boolean;

  constructor(param: T) {
    super(param, false);
  }

  setup() {
    this.active = this.active ?? false;
    const button = this.el
      .append("button")
      .classed("accordion-button", true)
      .classed("active", this.active)
      .on("click", () => {
        // toggle "active" class - shows/hide
        this.active = !button.classed("active");
        button.classed("active", this.active);
        panel.classed("active", this.active);
      })
      .text(this.param.name);

    const panel = this.el
      .append("div")
      .classed("accordion-panel", true)
      .classed("active", this.active);

    this.setup_panel(panel);
  }

  abstract setup_panel(panel: D3Div): void;
}

class HyperParamEditor extends CollapsibleParamEditor<HyperParam> {
  setup_panel(panel: D3Div) {
    const params = Object.entries(this.param.params)
      .filter(([attr]) => {
        const hidden = this.param.hidden;
        const x = !hidden.includes(attr);
        return x;
      })
      .map(([_, p]) => p);

    // if its an Optional HyperParam explicitly, inline the underlying value (if it's shown)
    const isOptional =
      params.length == 2 &&
      params[0].name == ".enabled" &&
      params[1].name === ".enabled_value";
    const isOptionalHyperParam = isOptional && "params" in params[1];

    panel
      .selectAll()
      .data(
        isOptional
          ? isOptionalHyperParam
            ? // inline the underlying value hyperparam
              [params[0], ...Object.values((params[1] as HyperParam).params)]
            : [params[0], { ...params[1], name: "" }]
          : params
      )
      .enter()
      .append((param: AnyParam): any => createParamControl(param).el.node());
  }
}

class VecParamEditor extends CollapsibleParamEditor<VecParam> {
  setup_panel(panel: D3Div) {
    const { val, name, min, max, log_scale, step } = this.param;
    for (let idx = 0; idx < this.param.val.length; idx++) {
      panel.append(() =>
        new NumParamEditor(
          {
            name: "",
            val: val[idx],
            min: min[idx],
            max: max[idx],
            log_scale,
            step,
            id: null,
          },
          false,
          (val) => {
            this.param.val[idx] = val;
            this.setParamVal(this.param.val);
          }
        ).el.node()
      );
    }
  }
}

// from msgpack docs https://github.com/msgpack/msgpack-javascript#decoding-a-blob
async function decodeFromBlob(blob: Blob) {
  return decode(await blob.arrayBuffer());
}

function formatNum(val: number) {
  const valStr = val.toString();
  const valAbs = Math.abs(val);
  // TODO: relate this behaviour to min and max somehow
  return valAbs > 0.001 && valAbs < 10000
    ? valStr.slice(0, 6)
    : valStr.length > 6
    ? d3.format(".2")(val)
    : valStr;
}