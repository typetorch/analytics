/**
 * IP allow lists for the admin routes (TYPETORCH_ADMIN_ALLOW_IPS): a comma-separated list of addresses and CIDR ranges,
 * IPv4 and IPv6. `::ffff:1.2.3.4` counts as 1.2.3.4. Pure functions, no I/O.
 */

export interface IpRule {
	version: 4 | 6;
	/** The address as a number (32 or 128 bits). */
	address: bigint;
	/** Leading bits that must match. */
	prefix: number;
	/** The rule as written, for the startup line. */
	text: string;
}

interface ParsedIp {
	version: 4 | 6;
	address: bigint;
}

function parseV4(text: string): bigint | undefined {
	const parts = text.split(".");
	if (parts.length !== 4) return undefined;
	let value = 0n;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const n = Number(part);
		if (n > 255) return undefined;
		value = (value << 8n) | BigInt(n);
	}
	return value;
}

function parseV6(text: string): bigint | undefined {
	let input = text;
	const zone = input.indexOf("%");
	if (zone >= 0) input = input.slice(0, zone);
	// An embedded IPv4 tail (::ffff:1.2.3.4) is two groups.
	const lastColon = input.lastIndexOf(":");
	if (lastColon >= 0 && input.slice(lastColon + 1).includes(".")) {
		const v4 = parseV4(input.slice(lastColon + 1));
		if (v4 === undefined) return undefined;
		input = `${input.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
	}
	const halves = input.split("::");
	if (halves.length > 2) return undefined;
	const groups = (s: string) => (s === "" ? [] : s.split(":"));
	const head = groups(halves[0]);
	const tail = halves.length === 2 ? groups(halves[1]) : [];
	if (halves.length === 1 && head.length !== 8) return undefined;
	if (halves.length === 2 && head.length + tail.length > 7) return undefined;
	const fill = halves.length === 2 ? new Array<string>(8 - head.length - tail.length).fill("0") : [];
	const all = [...head, ...fill, ...tail];
	if (all.length !== 8) return undefined;
	let value = 0n;
	for (const group of all) {
		if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return undefined;
		value = (value << 16n) | BigInt(parseInt(group, 16));
	}
	return value;
}

/** One address; IPv4-mapped IPv6 addresses become IPv4. */
export function parseIp(text: string): ParsedIp | undefined {
	const t = text.trim().replace(/^\[(.*)\]$/, "$1");
	if (!t) return undefined;
	if (t.includes(":")) {
		const v6 = parseV6(t);
		if (v6 === undefined) return undefined;
		if (v6 >> 32n === 0xffffn) return { version: 4, address: v6 & 0xffffffffn };
		return { version: 6, address: v6 };
	}
	const v4 = parseV4(t);
	return v4 === undefined ? undefined : { version: 4, address: v4 };
}

/** "10.0.0.0/8, 203.0.113.7, 2001:db8::/32" -> rules. Throws with the offending entry on a mistake. */
export function parseIpRules(list: string): IpRule[] {
	const rules: IpRule[] = [];
	for (const raw of list.split(",")) {
		const entry = raw.trim();
		if (!entry) continue;
		const slash = entry.indexOf("/");
		const ip = parseIp(slash >= 0 ? entry.slice(0, slash) : entry);
		if (!ip) throw new Error(`not an IP address or range: ${JSON.stringify(entry)}`);
		const max = ip.version === 4 ? 32 : 128;
		let prefix = max;
		if (slash >= 0) {
			const p = entry.slice(slash + 1);
			if (!/^\d{1,3}$/.test(p) || Number(p) > max) throw new Error(`bad prefix length in ${JSON.stringify(entry)}`);
			prefix = Number(p);
			// An IPv4-mapped IPv6 range (::ffff:10.0.0.0/104) is an IPv4 range: its prefix counts from the 96 mapped bits.
			if (ip.version === 4 && entry.includes(":")) prefix = Math.max(0, prefix - 96);
		}
		rules.push({ version: ip.version, address: ip.address, prefix, text: entry });
	}
	return rules;
}

/** Whether an address is covered by any rule. An address that doesn't parse is never allowed. */
export function ipAllowed(rules: readonly IpRule[], ip: string): boolean {
	const parsed = parseIp(ip);
	if (!parsed) return false;
	for (const rule of rules) {
		if (rule.version !== parsed.version) continue;
		const bits = rule.version === 4 ? 32n : 128n;
		const shift = bits - BigInt(rule.prefix);
		if (parsed.address >> shift === rule.address >> shift) return true;
	}
	return false;
}
