import assert from "node:assert/strict";
import { test } from "node:test";
import { buildJdText, decodeEntities, stripHtml, titleMatches } from "../src/filter.js";

test("title regex matches target roles", () => {
    const hits = [
        "Head of Marketing",
        "VP, Marketing",
        "VP Marketing",
        "Vice President, Marketing",
        "Director of Marketing",
        "Marketing Director, EMEA",
        "Senior Marketing Manager",
        "Product Marketing Lead",
        "Head of Growth",
        "Director of Growth",
        "Growth Marketing Manager",
        "Growth Marketing Lead",
        "Senior Manager, Demand Generation",
        "Senior Director of Growth",
        "Demand Generation Manager",
        "Demand Gen Lead",
    ];
    for (const title of hits) {
        assert.ok(titleMatches(title), `expected match: ${title}`);
    }
});

test("title regex rejects non-target roles", () => {
    const misses = [
        "Software Engineer",
        "Marketing Coordinator",
        "Account Executive",
        "Sales Development Representative",
        "Content Writer",
        "Growth Engineer",
        // The spec regex allows only 0-3 chars after "vp"/"vice president",
        // so the " of " variants (4 chars) intentionally do NOT match.
        "VP of Marketing",
        "Vice President of Marketing",
    ];
    for (const title of misses) {
        assert.ok(!titleMatches(title), `expected no match: ${title}`);
    }
});

test("decodeEntities handles named and numeric entities", () => {
    assert.equal(
        decodeEntities("&lt;p&gt;Own PLG &amp; ABM&lt;/p&gt; &#8211; now &#x2713;"),
        "<p>Own PLG & ABM</p> – now ✓",
    );
});

test("stripHtml removes tags, keeps structure readable", () => {
    const html = "<div><h2>About</h2><p>We are hiring.</p><ul><li>Own SEO</li><li>Own paid</li></ul><script>evil()</script></div>";
    const text = stripHtml(html);
    assert.match(text, /About\nWe are hiring\./);
    assert.match(text, /- Own SEO/);
    assert.doesNotMatch(text, /evil|<|>/);
});

test("buildJdText prepends location, decodes for greenhouse, caps at 2500", () => {
    const long = "&lt;p&gt;" + "growth ".repeat(600) + "&lt;/p&gt;";
    const jd = buildJdText({ location: "New York", description: long, decodeFirst: true });
    assert.ok(jd.startsWith("Location: New York\n\ngrowth"));
    assert.equal(jd.length, 2500);
});

test("buildJdText handles missing location and description", () => {
    const jd = buildJdText({ location: undefined, description: undefined, decodeFirst: false });
    assert.equal(jd, "Location: unspecified\n\n");
});
