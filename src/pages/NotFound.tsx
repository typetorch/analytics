import { Link } from "react-router";
import { EmptyState, PageHeader } from "@/components/common";

export default function NotFound() {
	return (
		<>
			<PageHeader title="Not found" />
			<EmptyState>
				No page here.{" "}
				<Link to="/" className="underline underline-offset-2">
					Back to the overview
				</Link>
				.
			</EmptyState>
		</>
	);
}
