/** A test-only port of the framework's tt-rec-1 encoder (framework/src/analytics/codec.ts RecWriter). */
const POSITION_SCALE = 8;
const CAMERA_SCALE = 16;
const I16_MAX = 32767;

const wrapYaw = (radians: number) => (Math.floor(((radians + Math.PI) / (Math.PI * 2)) * 256 + 0.5) % 256 + 256) % 256;
const quantizePitch = (radians: number) => Math.min(127, Math.max(-127, Math.floor((radians / (Math.PI / 2)) * 127 + 0.5)));
const i16 = (value: number) => Math.min(I16_MAX, Math.max(-I16_MAX, Math.floor(value + 0.5)));

export class RecWriter {
	private bytes: number[] = [1, 0, 100, 0];
	private lastMs = 0;
	private strings = new Map<string, number>();
	private anchor: [number, number, number] | undefined;
	samples = 0;

	private u8(v: number) {
		this.bytes.push(v & 0xff);
	}
	private u16(v: number) {
		this.bytes.push(v & 0xff, (v >> 8) & 0xff);
	}
	private i16(v: number) {
		this.u16(v < 0 ? v + 65536 : v);
	}
	private f32(v: number) {
		const b = new Uint8Array(new Float32Array([v]).buffer);
		this.bytes.push(...b);
	}
	private head(tag: number, atMs: number) {
		let delta = Math.max(0, Math.floor(atMs) - this.lastMs);
		while (delta > 65535) {
			this.u8(0);
			this.u16(65535);
			this.lastMs += 65535;
			delta -= 65535;
		}
		this.u8(tag);
		this.u16(delta);
		this.lastMs += delta;
	}
	private offsets(atMs: number, x: number, y: number, z: number): [number, number, number] {
		const fits = (v: number, o: number) => Math.abs((v - o) * POSITION_SCALE) <= I16_MAX;
		if (!this.anchor || !fits(x, this.anchor[0]) || !fits(y, this.anchor[1]) || !fits(z, this.anchor[2])) {
			this.head(1, atMs);
			this.f32(x);
			this.f32(y);
			this.f32(z);
			const f = new Float32Array([x, y, z]);
			this.anchor = [f[0], f[1], f[2]];
		}
		const a = this.anchor;
		return [i16((x - a[0]) * POSITION_SCALE), i16((y - a[1]) * POSITION_SCALE), i16((z - a[2]) * POSITION_SCALE)];
	}
	sample(atMs: number, cx: number, cy: number, cz: number, cyaw: number, kx: number, ky: number, kz: number, kyaw: number, kpitch: number) {
		const [ox, oy, oz] = this.offsets(atMs, cx, cy, cz);
		this.head(2, atMs);
		this.i16(ox);
		this.i16(oy);
		this.i16(oz);
		this.u8(wrapYaw(cyaw));
		this.i16(i16((kx - cx) * CAMERA_SCALE));
		this.i16(i16((ky - cy) * CAMERA_SCALE));
		this.i16(i16((kz - cz) * CAMERA_SCALE));
		this.u8(wrapYaw(kyaw));
		this.u8(quantizePitch(kpitch) & 0xff);
		this.samples++;
	}
	key(atMs: number, kind: number, code: number, processed = false) {
		this.head(4, atMs);
		this.u8((kind & 0x7f) + (processed ? 0x80 : 0));
		this.u16(code);
	}
	event(atMs: number, kind: number, text?: string) {
		let id = 65535;
		if (text !== undefined) {
			const known = this.strings.get(text);
			if (known !== undefined) id = known;
			else {
				id = this.strings.size;
				const bytes = new TextEncoder().encode(text);
				this.head(6, atMs);
				this.u16(id);
				this.u8(bytes.length);
				this.bytes.push(...bytes);
				this.strings.set(text, id);
			}
		}
		this.head(7, atMs);
		this.u8(kind);
		this.u16(id);
	}
	finish(last: boolean): string {
		this.bytes[1] = last ? 1 : 0;
		return Buffer.from(this.bytes).toString("base64");
	}
}
