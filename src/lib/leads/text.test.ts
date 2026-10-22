import { describe, expect, it } from "vitest";

import { domainOf, emailLabel, emailOnDomain, findEmails, htmlToText } from "./text";

describe("reading leads' text", () => {
  it("turns post HTML into text, with links written out", () => {
    expect(htmlToText('Acme | Android &amp; iOS<p>Apply at <a href="https:&#x2F;&#x2F;acme.com&#x2F;jobs">our page</a>')).toBe(
      "Acme | Android & iOS\nApply at our page (https://acme.com/jobs)",
    );
  });

  it("finds published addresses, also the hidden ways people write them", () => {
    const text = "Email jobs@acme.io or jane [at] acme [dot] io, or ravi(at)acme.io, or sam at acme dot co dot in. Not logo@2x.png or noreply@acme.io.";
    expect(findEmails(text)).toEqual(["jobs@acme.io", "jane@acme.io", "ravi@acme.io", "sam@acme.co.in"]);
  });

  it("says what an address is for, and whether it's the company's own", () => {
    expect(emailLabel("careers@acme.io")).toBe("Hiring");
    expect(emailLabel("founders@acme.io")).toBe("Founders");
    expect(emailLabel("hello@acme.io")).toBe("General");
    expect(emailLabel("priya@acme.io")).toBe("Person");
    expect(domainOf("https://www.Acme.io/careers")).toBe("acme.io");
    expect(emailOnDomain("jobs@acme.io", "acme.io")).toBe(true);
    expect(emailOnDomain("jobs@eu.acme.io", "acme.io")).toBe(true);
    expect(emailOnDomain("someone@gmail.com", "acme.io")).toBe(false);
  });
});
