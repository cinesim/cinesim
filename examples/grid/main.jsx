import { AuroraBackground } from "./components/AuroraBackground.jsx";
import { LowerThird } from "./components/LowerThird.jsx";

export const main = (
  <composition
    id="sequence_main"
    name="Five-person grid"
    width={1920}
    height={1080}
    fps={30}
    background="#070914"
  >
    <timeline id="timeline_main">
      <track id="track_scenes" kind="overlay" name="Scenes" muted={false} locked={false}>
        <clip id="clip_grid" start={seconds(0)} duration={seconds(12)}>
          <group id="scene">
            <AuroraBackground id="background" accent="#7c5cff" />
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
            <colorgrade
              id="grade"
              exposure={0.08}
              contrast={1.06}
              saturation={1.12}
              temperature={-0.04}
              tint={0.02}
            />
            <LowerThird id="guest-title" name="Maya Chen" role="Designing tools for thought" />
          </group>
        </clip>
      </track>
    </timeline>
  </composition>
);

export default main;
