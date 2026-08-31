export function AuroraBackground({ accent = "#6f5cff" }) {
  return (
    <group id="root" opacity={1}>
      <rect id="base" x={px(0)} y={px(0)} width={px(1920)} height={px(1080)} fill="#070914" />
      <rect
        id="glow"
        x={px(1080)}
        y={px(-180)}
        width={px(920)}
        height={px(920)}
        fill={accent}
        radius={px(460)}
        blur={px(140)}
        opacity={0.24}
      >
        <animate property="opacity">
          <key at={seconds(0)} value={0.18} />
          <key at={seconds(6)} value={0.34} easing="ease-in-out" />
          <key at={seconds(12)} value={0.18} easing="ease-in-out" />
        </animate>
      </rect>
    </group>
  );
}
