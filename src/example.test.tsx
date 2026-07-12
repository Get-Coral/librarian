import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

function Greeting({ name }: { name: string }) {
	return <p>Hello {name}</p>;
}

describe("example", () => {
	it("renders a component", () => {
		render(<Greeting name="Coral" />);
		expect(screen.getByText("Hello Coral")).toBeTruthy();
	});
});
