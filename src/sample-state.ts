import { randomUUID } from 'node:crypto';

export interface SampleFileIO {
  readFileSync(file: string, encoding: 'utf8'): string;
  writeFileSync(file: string, data: string, encoding: 'utf8'): void;
  renameSync(from: string, to: string): void;
  unlinkSync(file: string): void;
}

export interface SampleState { count: number }

export function createSampleState(file: string, io: SampleFileIO) {
  function read(): SampleState {
    let contents: string;
    try {
      contents = io.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { count: 0 };
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      if (parsed !== null && typeof parsed === 'object' && 'version' in parsed && parsed.version === 1 &&
          'count' in parsed && typeof parsed.count === 'number' && Number.isSafeInteger(parsed.count) && parsed.count >= 0) {
        return { count: parsed.count };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return { count: 0 };
  }

  function increment(): SampleState {
    const current = read();
    if (current.count === Number.MAX_SAFE_INTEGER) throw new RangeError('sample count limit reached');
    const next = { count: current.count + 1 };
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      io.writeFileSync(temporary, JSON.stringify({ version: 1, ...next }), 'utf8');
      io.renameSync(temporary, file);
    } catch (error) {
      try { io.unlinkSync(temporary); } catch { /* No temporary file may have been created. */ }
      throw error;
    }
    return next;
  }

  return { read, increment };
}
