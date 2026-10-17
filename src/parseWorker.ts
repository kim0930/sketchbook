import { parseSkp } from 'openskp';
import { importModel } from './model/importSkp.ts';
import type { SketchDocument } from './model/types.ts';

export type ParseProgress = { ok: 'progress'; stage: string; current: number; total: number };
export type ParseDone = { ok: true; doc: SketchDocument; warnings: string[] };
export type ParseFail = { ok: false; error: string };
export type ParseMessage = ParseProgress | ParseDone | ParseFail;

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const model = parseSkp(event.data, {
      onProgress: (info) => {
        const message: ParseProgress = { ok: 'progress', stage: info.stage, current: info.current, total: info.total };
        self.postMessage(message);
      },
    });
    self.postMessage({ ok: 'progress', stage: 'import', current: 0, total: 1 } satisfies ParseProgress);
    const result = importModel(model, '모델');
    const done: ParseDone = { ok: true, doc: result.doc, warnings: result.warnings };
    self.postMessage(done);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fail: ParseFail = { ok: false, error: message };
    self.postMessage(fail);
  }
};
