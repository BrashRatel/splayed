import { assert, assertEquals } from "./assert.ts";
import { fromHex, toHex } from "../src/core/bytes.ts";
import {
  bytewordsDecode,
  bytewordsEncode,
  cborBytes,
  crc32,
  psbtFromUr,
  psbtToUr,
  URDecoder,
  UREncoder,
  URError,
} from "../src/core/ur.ts";

interface Vector {
  messageHex: string;
  cborHex: string;
  type: string;
  maxFragmentLen: number;
  parts: string[];
}
const vectors: Vector[] = JSON.parse(await Deno.readTextFile("testdata/ur_vectors.json"));

Deno.test("ur: crc32 matches the standard check value", () => {
  assertEquals(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

Deno.test("ur: bytewords round trip and reject a wrong checksum", () => {
  const data = fromHex("00ff10ab");
  assertEquals(toHex(bytewordsDecode(bytewordsEncode(data))), "00ff10ab");
  const text = bytewordsEncode(data);
  const bad = text.slice(0, 2) + (text.slice(2, 4) === "ab" ? "ac" : "ab") + text.slice(4);
  let threw = false;
  try {
    bytewordsDecode(bad);
  } catch (error) {
    threw = error instanceof URError;
  }
  assert(threw);
});

Deno.test("ur: encoder output equals the reference implementation, part for part", () => {
  for (const v of vectors) {
    const enc = new UREncoder(v.type, fromHex(v.cborHex), v.maxFragmentLen);
    const got = v.parts.map(() => enc.nextPart());
    assertEquals(got, v.parts, `message of ${v.messageHex.length / 2} bytes`);
  }
});

Deno.test("ur: decoder rebuilds the message from the reference's frames, in any order", () => {
  for (const v of vectors) {
    for (const order of ["forward", "backward", "mixed-only"] as const) {
      let frames = [...v.parts];
      if (order === "backward") frames.reverse();
      // Lose every plain frame but one: only fountain frames can fill the gaps.
      if (order === "mixed-only" && v.parts.length > 3) {
        const seqLen = Number(/ur:[^/]+\/\d+-(\d+)\//u.exec(v.parts[0])![1]);
        frames = [v.parts[0], ...v.parts.slice(seqLen)];
      }
      const dec = new URDecoder();
      for (const f of frames) if (!dec.isComplete) dec.receive(f);
      assert(dec.isComplete, `${order}, ${v.messageHex.length / 2} bytes`);
      assertEquals(toHex(dec.result.cbor), v.cborHex);
      assertEquals(dec.result.type, v.type);
    }
  }
});

Deno.test("ur: repeated frames are ignored and progress is reported", () => {
  const v = vectors[3];
  const dec = new URDecoder();
  assertEquals(dec.receive(v.parts[0]), true);
  assertEquals(dec.receive(v.parts[0]), false);
  assert(dec.progress.percent > 0 && dec.progress.percent < 100);
});

Deno.test("ur: frames from two transfers are never mixed", () => {
  const dec = new URDecoder();
  dec.receive(vectors[2].parts[0]);
  let threw = false;
  try {
    dec.receive(vectors[3].parts[1]);
  } catch (error) {
    threw = error instanceof URError;
  }
  assert(threw);
});

Deno.test("ur: a PSBT round trips as crypto-psbt, single and multi-part", () => {
  for (const size of [60, 450, 3000]) {
    const psbt = new Uint8Array(size).map((_, i) => (i * 31 + 7) & 255);
    psbt.set([0x70, 0x73, 0x62, 0x74, 0xff]);
    const { type, frames } = psbtToUr(psbt, 100);
    assertEquals(type, "crypto-psbt");
    assert(frames.every((f) => f.startsWith("ur:crypto-psbt/")));
    const dec = new URDecoder();
    // Drop the first frame, as a scanner that started late would.
    for (const f of frames.length > 1 ? frames.slice(1) : frames) {
      if (!dec.isComplete) dec.receive(f);
    }
    assert(dec.isComplete, `${size} bytes`);
    assertEquals(toHex(psbtFromUr(dec)), toHex(psbt));
  }
});

Deno.test("ur: garbage and other transfer types are refused", () => {
  for (const bad of ["", "hello", "ur:crypto-psbt/", "ur:crypto-psbt/1-3/notbytewords!"]) {
    let threw = false;
    try {
      new URDecoder().receive(bad);
    } catch (error) {
      threw = error instanceof URError;
    }
    assert(threw, bad);
  }
  const other = new UREncoder("crypto-account", cborBytes(new Uint8Array(20)), 100);
  const dec = new URDecoder();
  dec.receive(other.nextPart());
  let threw = false;
  try {
    psbtFromUr(dec);
  } catch (error) {
    threw = error instanceof URError;
  }
  assert(threw);
});
