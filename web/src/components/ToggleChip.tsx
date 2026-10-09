/**
 * A pick-to-toggle chip (the Compare section's builds, a live server's History): picked = filled with the primary colour and
 * its contrasting text, plus a check; not picked = outline and muted text. `aria-pressed` carries the state for assistive
 * tech and the keyboard focus ring comes from Button. Both read in light and dark (primary flips with the theme).
 */
import { Check } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

export interface ToggleChipProps extends Omit<ComponentProps<typeof Button>, "variant" | "aria-pressed"> {
	pressed: boolean;
}

export function ToggleChip({ pressed, className, children, ...props }: ToggleChipProps) {
	return (
		<Button
			type="button"
			size="sm"
			variant={pressed ? "default" : "outline"}
			aria-pressed={pressed}
			data-pressed={pressed}
			className={cn("h-7", !pressed && "text-muted-foreground", className)}
			{...props}
		>
			{pressed ? <Check aria-hidden data-icon="inline-start" /> : null}
			{children}
		</Button>
	);
}
