import { decodePeaks, encodePeaks } from '@ondes/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaveformEditor } from './waveform-editor.tsx';

// The interactive waveform in happy-dom (no layout): the container is given a width by hand.

const peaks = decodePeaks(
  encodePeaks({
    sampleRate: 44_100,
    channels: 1,
    lengthSamples: 441_000,
    levels: [{ samplesPerPoint: 4096, points: 108, values: new Int8Array(216) }],
  }),
);

describe('WaveformEditor', () => {
  let widthSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    widthSpy = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 128,
      width: 1000,
      height: 128,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  });
  afterEach(() => {
    widthSpy.mockRestore();
    vi.restoreAllMocks();
  });

  const view = { fromSample: 0, toSample: 441_000 };

  it('places markers and moves them with the keyboard', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(
      <WaveformEditor
        peaks={peaks}
        view={view}
        onViewChange={() => {}}
        markers={[
          { id: 'in', sample: 44_100, label: 'In', color: 'red' },
          { id: 'out', sample: 500_000, label: 'Out', color: 'blue' },
        ]}
        onMarkerChange={onChange}
        onMarkerCommit={onCommit}
      />,
    );
    const handle = screen.getByRole('slider', { name: 'In' });
    expect(handle.parentElement?.style.left).toBe('100px');
    // Out of view: not rendered.
    expect(screen.queryByRole('slider', { name: 'Out' })).toBeNull();
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('in', 44_541);
    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(onCommit).toHaveBeenLastCalledWith('in', 39_690);
  });

  it('drags a marker and seeks on click', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const onSeek = vi.fn();
    const { container } = render(
      <WaveformEditor
        peaks={peaks}
        view={view}
        onViewChange={() => {}}
        markers={[{ id: 'in', sample: 44_100, label: 'In', color: 'red' }]}
        onMarkerChange={onChange}
        onMarkerCommit={onCommit}
        onSeek={onSeek}
      />,
    );
    const handle = screen.getByRole('slider', { name: 'In' });
    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 200, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith('in', 88_200);
    fireEvent.pointerUp(handle, { clientX: 200, pointerId: 1 });
    expect(onCommit).toHaveBeenLastCalledWith('in', 88_200);
    fireEvent.click(container.querySelector('[data-waveform]') as Element, { clientX: 500 });
    expect(onSeek).toHaveBeenCalledWith(220_500);
  });

  it('zooms around the pointer with the wheel', () => {
    const onViewChange = vi.fn();
    const { container } = render(
      <WaveformEditor peaks={peaks} view={view} onViewChange={onViewChange} />,
    );
    const group = container.querySelector('[data-waveform]') as Element;
    fireEvent.wheel(group, { deltaY: -100, clientX: 500 });
    const next = onViewChange.mock.lastCall?.[0];
    expect(next.toSample - next.fromSample).toBeLessThan(441_000);
    expect((next.fromSample + next.toSample) / 2).toBeCloseTo(220_500, -1);
  });
});
