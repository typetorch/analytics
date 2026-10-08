import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toMermaid } from "@/lib/graph-text";
import type { GraphData } from "@/lib/types";

/** Copies the graph as Mermaid text (for docs, PRs or https://mermaid.live). */
export function MermaidButton({ graph }: { graph: GraphData }) {
	const [copied, setCopied] = useState(false);
	return (
		<Button
			variant="outline"
			size="sm"
			onClick={async () => {
				await navigator.clipboard.writeText(toMermaid(graph));
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			}}
		>
			{copied ? <Check /> : <Copy />}
			{copied ? "Copied" : "Copy Mermaid"}
		</Button>
	);
}
