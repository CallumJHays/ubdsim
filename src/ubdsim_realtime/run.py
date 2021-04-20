import utime
from typing import List, Optional, Set

from ubdsim import Block, BlockDiagram, TransferBlock
from ubdsim.state import BDSimState
import gc

def run(bd: BlockDiagram, max_time: Optional[float]=None):

    state = bd.state = BDSimState()
    state.T = max_time

    for b in bd.blocklist:
        assert not isinstance(b, TransferBlock), \
            "Transfer blocks in realtime mode are not supported (yet)"

    rt_blocks: List[Block] = [b for b in bd.blocklist if not b._sim_only]
    assert rt_blocks, \
        "No realtime-runnable blocks in diagram.{}" \
            .format("All blocks are marked as simulation only.{}"
                    if bd.blocklist else "{}")
    # plan out an order of block execution and propagation.
    # start with 'clocked' blocks, as their timing is important and they should be run asap
    plan: List[Block] = [
        b for b in rt_blocks
        if b.blockclass == 'clocked'
    ]

    # the ones that don't have inputs ('source' and 'transfer')
    plan += [
        b for b in rt_blocks
        if b.blockclass in ('source', 'transfer')
    ]
    
    for idx in range(len(rt_blocks)):
        for port, outwires in enumerate(plan[idx].outports):
            for w in outwires:
                block: Block = w.end.block
                assert not block._sim_only

                if block in plan:
                    continue

                block.inputs[port] = True
                if all(in_plan for in_plan in block.inputs):
                    plan.append(block)
    
    assert len(plan) == len(rt_blocks)

    # if tuner:
    #     # needs to happen after bd.start() because the autogen'd block-names
    #     # are used internally
    #     tuner.setup(bd.gui_params, bd)
    c = 0

    FPS_AV_FACTOR = 1 / 5  # smaller number averages over more frames
    FPS_AV_FACTOR_INV = 1 - FPS_AV_FACTOR
    fps: float = 30

    frequency = None
    bd.start()
    t_us = utime.ticks_us()
    state.t = t_us / 1e6

    # until its time to stop
    while not state.stop and (max_time is None or state.t < max_time):
        bd.reset()

        last_t_us = t_us
        t_us = utime.ticks_us()
        dt_us = utime.ticks_diff(t_us, last_t_us)
        assert dt_us > 0
        dt = dt_us / 1e6
        state.t += dt

        for b in plan:
            out = b.output(state.t)
            for (n, ws) in enumerate(b.outports):
                for w in ws:
                    w.end.block.inputs[w.end.port] = out[n]
            
        # update state, displays, etc
        bd.step()

        # forcibly collect garbage to assist in fps constancy
        gc.collect()

        # moving average fps
        # TODO: move into its own block
        frequency = 1 / dt if frequency else fps
        fps = FPS_AV_FACTOR * frequency + FPS_AV_FACTOR_INV * fps
        c += 1
        if c == 30:
            print('FPS', fps)
            c = 0
