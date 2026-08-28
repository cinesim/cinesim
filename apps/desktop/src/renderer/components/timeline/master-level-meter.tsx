import { useEffect, useRef, useState } from "react";
import { useRendererStore } from "../../store/renderer-store-context";

const FLOOR_DB = -60;
const METER_TICKS = [0, -6, -12, -24, -36, -48, -60] as const;

export function meterPercent(db: number): number {
  return Math.min(100, Math.max(0, ((db - FLOOR_DB) / -FLOOR_DB) * 100));
}

export function MasterLevelMeter() {
  const runtime = useRendererStore((state) => state.playbackRuntime?.snapshot ?? null);
  const levels = runtime?.playing ? runtime.masterPeakDb : ([FLOOR_DB, FLOOR_DB] as const);
  const [leftLevel, rightLevel] = levels;
  const [holds, setHolds] = useState<readonly [number, number]>([FLOOR_DB, FLOOR_DB]);
  const holdTimers = useRef<
    [ReturnType<typeof setTimeout> | null, ReturnType<typeof setTimeout> | null]
  >([null, null]);

  useEffect(() => {
    setHolds((current) => {
      const next: [number, number] = [...current];
      for (const channel of [0, 1] as const) {
        const nextLevel = channel === 0 ? leftLevel : rightLevel;
        if (nextLevel <= current[channel]) continue;
        next[channel] = nextLevel;
        if (holdTimers.current[channel]) clearTimeout(holdTimers.current[channel]!);
        holdTimers.current[channel] = setTimeout(() => {
          setHolds((held) => {
            const released: [number, number] = [...held];
            released[channel] = FLOOR_DB;
            return released;
          });
          holdTimers.current[channel] = null;
        }, 900);
      }
      return next;
    });
  }, [leftLevel, rightLevel]);

  useEffect(
    () => () => {
      for (const timer of holdTimers.current) if (timer) clearTimeout(timer);
    },
    [],
  );

  return (
    <aside
      className="flex min-h-0 flex-col border-l border-border bg-panel"
      aria-label="Master audio level"
    >
      <div className="grid h-6 shrink-0 place-items-center border-b border-border text-[9px] font-semibold uppercase tracking-[0.14em] text-muted">
        Master
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 pt-3">
        <meter className="sr-only" min={FLOOR_DB} max={0} value={Math.max(leftLevel, rightLevel)}>
          {Math.round(Math.max(leftLevel, rightLevel))} dB
        </meter>
        <div className="grid min-h-0 flex-1 grid-cols-[20px_minmax(0,1fr)] gap-x-1.5">
          <div className="relative text-[8px] leading-none text-muted tabular-nums">
            {METER_TICKS.map((tick) => (
              <span
                key={tick}
                className="absolute right-0 -translate-y-1/2"
                style={{ top: `${100 - meterPercent(tick)}%` }}
              >
                {tick}
              </span>
            ))}
          </div>
          <div className="flex min-h-0 gap-1.5">
            {([0, 1] as const).map((channel) => {
              const level = channel === 0 ? leftLevel : rightLevel;
              const hold = holds[channel];
              return (
                <div
                  key={channel}
                  className="relative min-w-0 flex-1 overflow-hidden rounded-[2px] bg-black/75 ring-1 ring-inset ring-white/10"
                >
                  <div
                    className="absolute inset-x-0 bottom-0 origin-bottom transition-transform duration-100 ease-out"
                    style={{
                      height: "100%",
                      transform: `scaleY(${meterPercent(level) / 100})`,
                      background:
                        "linear-gradient(to top, #20b86a 0%, #4fc95b 62%, #e0c72e 82%, #f18b2f 91%, #ee4d52 100%)",
                    }}
                  />
                  <div className="meter-segments pointer-events-none absolute inset-0" />
                  {hold > FLOOR_DB && (
                    <span
                      className="absolute inset-x-0 h-px bg-white shadow-[0_0_3px_rgb(255_255_255/0.8)]"
                      style={{ bottom: `${meterPercent(hold)}%` }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
        <div className="mt-1 grid grid-cols-[20px_minmax(0,1fr)] gap-x-1.5">
          <span />
          <div className="flex justify-around text-[8px] leading-none font-semibold text-muted">
            <span>L</span>
            <span>R</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
