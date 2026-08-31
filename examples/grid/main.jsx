import { AuroraBackground } from "./components/AuroraBackground.jsx";
import { LowerThird } from "./components/LowerThird.jsx";

export default (
  <composition
    id="five-person-scene"
    width={1920}
    height={1080}
    frameRate={30}
    duration={seconds(12)}
    background="#070914"
  >
    <AuroraBackground id="background" accent="#7c5cff" />

    <colorgrade
      id="grade"
      exposure={0.08}
      contrast={1.06}
      saturation={1.12}
      temperature={-0.04}
      tint={0.02}
    >
      <grid
        id="speakers"
        x={px(72)}
        y={px(72)}
        width={px(1776)}
        height={px(850)}
        columns={3}
        rows={2}
        gap={px(20)}
      >
        <video id="maya" source={asset("asset_maya")} fit="cover" radius={px(24)} />
        <video id="noah" source={asset("asset_noah")} fit="cover" radius={px(24)} />
        <video id="mina" source={asset("asset_mina")} fit="cover" radius={px(24)} />
        <video id="leo" source={asset("asset_leo")} fit="cover" radius={px(24)} />
        <video id="zara" source={asset("asset_zara")} fit="cover" radius={px(24)} />
      </grid>
    </colorgrade>

    <LowerThird id="guest-title" name="Maya Chen" role="Designing tools for thought" />
  </composition>
);
