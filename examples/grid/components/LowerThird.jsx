export function LowerThird({ name, role, accent = "#9b8cff" }) {
  return (
    <group id="root" x={px(96)} y={px(880)} opacity={0}>
      <animate property="opacity">
        <key at={seconds(0.4)} value={0} />
        <key at={seconds(0.9)} value={1} easing="ease-out" />
      </animate>

      <rect
        id="panel"
        x={px(0)}
        y={px(0)}
        width={px(720)}
        height={px(142)}
        fill="#12162a"
        radius={px(28)}
        opacity={0.94}
      />
      <rect
        id="accent"
        x={px(20)}
        y={px(22)}
        width={px(8)}
        height={px(98)}
        fill={accent}
        radius={px(4)}
      />
      <text
        id="name"
        text={name}
        x={px(54)}
        y={px(28)}
        fontSize={px(42)}
        fontWeight={650}
        color="#ffffff"
      />
      <text
        id="role"
        text={role}
        x={px(54)}
        y={px(82)}
        fontSize={px(24)}
        fontWeight={450}
        color="#b7bdd7"
      />
    </group>
  );
}
