// Reusable waveform (#24), also used by the segue editor (#58). No cue-specific logic here.
export { type DrawPeaksStyle, drawPeaks, pickLevel } from './draw.ts';
export { fetchPeaks, peaksKey, peaksQuery, usePeaks } from './peaks.ts';
export {
  centreView,
  clampView,
  fullView,
  MIN_VIEW_SAMPLES,
  samplesPerPixel,
  sampleToX,
  scrollView,
  type WaveformView,
  xToSample,
  zoomView,
} from './view.ts';
export { useElementWidth, Waveform, type WaveformProps } from './waveform.tsx';
export {
  WaveformEditor,
  type WaveformEditorProps,
  type WaveformMarker,
  type WaveformRegion,
} from './waveform-editor.tsx';
