// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToggleChip } from "./ToggleChip";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

afterEach(cleanup);

describe("ToggleChip", () => {
	it("picked: aria-pressed true, filled with the primary colour and its text, and a check", () => {
		render(<ToggleChip pressed>e4f5a6b #42</ToggleChip>);
		const chip = screen.getByRole("button", { name: "e4f5a6b #42" });
		expect(chip.getAttribute("aria-pressed")).toBe("true");
		expect(chip.className).toContain("bg-primary");
		expect(chip.className).toContain("text-primary-foreground");
		expect(chip.querySelector("svg.lucide-check")).not.toBeNull();
		// The check is decoration: the accessible name stays the label.
		expect(chip.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
	});

	it("not picked: aria-pressed false, an outline with muted text, no check", () => {
		render(<ToggleChip pressed={false}>a1b2c3d #41</ToggleChip>);
		const chip = screen.getByRole("button", { name: "a1b2c3d #41" });
		expect(chip.getAttribute("aria-pressed")).toBe("false");
		expect(chip.className).not.toContain("bg-primary");
		expect(chip.className).toContain("border-border");
		expect(chip.className).toContain("text-muted-foreground");
		expect(chip.querySelector("svg")).toBeNull();
	});

	it("keeps the button's keyboard focus ring and is a real, focusable button that clicks", () => {
		const onClick = vi.fn();
		render(
			<ToggleChip pressed={false} onClick={onClick}>
				Build
			</ToggleChip>,
		);
		const chip = screen.getByRole("button", { name: "Build" });
		expect(chip.getAttribute("type")).toBe("button");
		expect(chip.className).toContain("focus-visible:ring-3");
		chip.focus();
		expect(document.activeElement).toBe(chip);
		fireEvent.click(chip);
		expect(onClick).toHaveBeenCalledTimes(1);
	});
});

describe("ToggleGroup items", () => {
	it("the picked one is filled with the primary colour and carries a check; the others are plain", () => {
		render(
			<ToggleGroup type="single" variant="outline" value="p50" aria-label="Percentile">
				<ToggleGroupItem value="p10">p10</ToggleGroupItem>
				<ToggleGroupItem value="p50">p50</ToggleGroupItem>
			</ToggleGroup>,
		);
		const picked = screen.getByRole("radio", { name: "p50" });
		const other = screen.getByRole("radio", { name: "p10" });
		expect(picked.getAttribute("aria-checked")).toBe("true");
		expect(picked.getAttribute("data-state")).toBe("on");
		expect(other.getAttribute("aria-checked")).toBe("false");
		expect(other.getAttribute("data-state")).toBe("off");
		// One class set for both; the data-state selectors decide which one shows the fill and the check.
		for (const item of [picked, other]) {
			expect(item.className).toContain("data-[state=on]:bg-primary");
			expect(item.className).toContain("data-[state=on]:text-primary-foreground");
			expect(item.className).toContain("focus-visible:ring-");
			expect(item.querySelector("svg.lucide-check")?.getAttribute("class")).toContain("group-data-[state=on]/toggle:inline-block");
			expect(item.querySelector("svg.lucide-check")?.getAttribute("class")).toContain("hidden");
		}
	});

	it("a multiple-choice toggle uses aria-pressed, filled the same way", () => {
		render(
			<ToggleGroup type="multiple" value={["a"]} aria-label="Pick">
				<ToggleGroupItem value="a">A</ToggleGroupItem>
				<ToggleGroupItem value="b">B</ToggleGroupItem>
			</ToggleGroup>,
		);
		expect(screen.getByRole("button", { name: "A" }).getAttribute("aria-pressed")).toBe("true");
		expect(screen.getByRole("button", { name: "B" }).getAttribute("aria-pressed")).toBe("false");
		expect(screen.getByRole("button", { name: "A" }).className).toContain("aria-pressed:bg-primary");
	});
});
