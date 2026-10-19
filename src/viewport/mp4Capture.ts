import {
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  VIDEO_CODECS,
  getFirstEncodableVideoCodec,
} from 'mediabunny';

export type Mp4Capture = {
  snapshot: (canvas: HTMLCanvasElement) => void;
  finish: () => void;
  discard: () => void;
};

const frameSize = (canvas: HTMLCanvasElement) => {
  const maxEdge = 1920;
  let width = canvas.width;
  let height = canvas.height;
  const longEdge = Math.max(width, height);
  if (longEdge > maxEdge) {
    const scale = maxEdge / longEdge;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  return { width: Math.max(2, width & ~1), height: Math.max(2, height & ~1) };
};

export async function beginMp4Capture(
  canvas: HTMLCanvasElement,
  onDone: (blob: Blob | null, error?: string) => void,
): Promise<Mp4Capture | null> {
  const { width, height } = frameSize(canvas);
  if (canvas.width < 2 || canvas.height < 2) {
    onDone(null, '화면 크기가 너무 작아 동영상을 만들 수 없습니다.');
    return null;
  }
  const format = new Mp4OutputFormat({ fastStart: 'in-memory' });
  const allowed = new Set(format.getSupportedCodecs());
  const codec = await getFirstEncodableVideoCodec(
    VIDEO_CODECS.filter((item) => allowed.has(item)),
    { width, height, quality: new Quality('high'), frameRate: 30 },
  );
  if (!codec) {
    onDone(null, '이 브라우저에서는 MP4 동영상을 만들 수 없습니다.');
    return null;
  }
  const frame = new OffscreenCanvas(width, height);
  const ctx = frame.getContext('2d', { alpha: false });
  if (!ctx) {
    onDone(null, '이 브라우저에서는 MP4 동영상을 만들 수 없습니다.');
    return null;
  }
  const target = new BufferTarget();
  const output = new Output({ format, target });
  const source = new CanvasSource(frame, {
    codec,
    quality: new Quality('high'),
    keyFrameInterval: 1,
  });
  output.addVideoTrack(source);
  try {
    await output.start();
  } catch {
    onDone(null, '이 브라우저에서는 MP4 동영상을 만들 수 없습니다.');
    return null;
  }

  let timestamp = 0;
  let last = 0;
  let depth = 0;
  let failed = false;
  let closed = false;
  let chain = Promise.resolve();

  const fail = (message: string) => {
    if (closed) return;
    closed = true;
    failed = true;
    void output.cancel().catch(() => {});
    onDone(null, message);
  };

  return {
    snapshot: (glCanvas) => {
      if (closed || failed) return;
      const now = performance.now();
      const elapsed = last === 0 ? 1 / 30 : (now - last) / 1000;
      if (timestamp > 0 && elapsed < 1 / 30) return;
      if (depth > 2) return;
      last = now;
      const duration = Math.min(Math.max(elapsed, 1 / 45), 0.2);
      const at = timestamp;
      timestamp += duration;
      depth += 1;
      ctx.drawImage(glCanvas, 0, 0, width, height);
      chain = chain.then(() => source.add(at, duration)).then(
        () => {
          depth -= 1;
        },
        () => {
          depth -= 1;
          fail('동영상 프레임을 만들지 못했습니다.');
        },
      );
    },
    finish: () => {
      if (closed) return;
      closed = true;
      void chain.then(async () => {
        if (failed) return;
        if (timestamp <= 0) {
          await output.cancel().catch(() => {});
          onDone(null, '동영상 프레임을 만들지 못했습니다.');
          return;
        }
        source.close();
        await output.finalize();
        const buffer = target.buffer;
        if (!buffer?.byteLength) {
          onDone(null, '동영상 프레임을 만들지 못했습니다.');
          return;
        }
        onDone(new Blob([buffer], { type: 'video/mp4' }));
      }).catch(() => {
        if (!failed) onDone(null, '동영상 프레임을 만들지 못했습니다.');
      });
    },
    discard: () => {
      if (closed) return;
      closed = true;
      failed = true;
      void output.cancel().catch(() => {});
    },
  };
}
