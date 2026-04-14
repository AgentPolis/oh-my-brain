import { describe, expect, it } from "vitest";
import { extractEvents, resolveDate } from "../cli/event-extractor.js";

const baseContext = {
  sessionId: "sess-1",
  turnIndex: 4,
  sessionDate: "2026-03-20T12:00:00.000Z",
};

describe("extractEvents", () => {
  it("extracts a service event and carries adjacent problem detail", () => {
    const events = extractEvents(
      { role: "user", content: "I got my car serviced last Tuesday. The GPS wasn't working." },
      baseContext
    );
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].what).toBe("car serviced");
    expect(events[0].detail).toContain("GPS");
    expect(events[0].category).toBe("vehicle");
  });

  it("extracts an acquisition event with exact date", () => {
    const [event] = extractEvents(
      { role: "user", content: "I bought a Samsung Galaxy S22 on February 20th" },
      baseContext
    );
    expect(event.what).toContain("Samsung Galaxy S22");
    expect(event.ts).toBe("2026-02-20T00:00:00.000Z");
    expect(event.ts_precision).toBe("exact");
  });

  it("returns [] for noise messages", () => {
    expect(extractEvents({ role: "user", content: "ok" }, baseContext)).toEqual([]);
  });

  it("returns [] for assistant messages", () => {
    expect(extractEvents({ role: "assistant", content: "I bought a car." }, baseContext)).toEqual([]);
  });

  it("extracts multiple events from one message", () => {
    const events = extractEvents(
      { role: "user", content: "I bought a laptop and I flew to Vegas for a conference." },
      baseContext
    );
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.category)).toEqual(["shopping", "travel"]);
  });

  it("does not extract intentions", () => {
    expect(
      extractEvents({ role: "user", content: "I'm thinking about buying a car next month." }, baseContext)
    ).toEqual([]);
  });

  it("extracts person names from role phrases", () => {
    const [event] = extractEvents(
      { role: "user", content: "I got my car serviced last Tuesday and my mechanic Tom said the GPS was dead." },
      baseContext
    );
    expect(event.who).toEqual(["Tom"]);
  });

  it("extracts people from met statements", () => {
    const [event] = extractEvents(
      { role: "user", content: "I met Sarah for coffee yesterday." },
      baseContext
    );
    expect(event.what).toBe("met Sarah for coffee");
    expect(event.who).toContain("Sarah");
  });

  it("detects frustrated sentiment", () => {
    const [event] = extractEvents(
      { role: "user", content: "I got my car serviced yesterday and I'm frustrated that the GPS still failed." },
      baseContext
    );
    expect(event.sentiment).toBe("frustrated");
  });

  it("detects anxious sentiment", () => {
    const [event] = extractEvents(
      { role: "user", content: "I started a new job last Monday and I'm worried about the commute." },
      baseContext
    );
    expect(event.sentiment).toBe("anxious");
  });

  it("detects positive sentiment", () => {
    const [event] = extractEvents(
      { role: "user", content: "I bought a new guitar yesterday and I'm excited to play it." },
      baseContext
    );
    expect(event.sentiment).toBe("positive");
  });

  it("extracts travel category from flights", () => {
    const [event] = extractEvents(
      { role: "user", content: "I flew to Las Vegas for a conference." },
      baseContext
    );
    expect(event.category).toBe("travel");
    expect(event.where).toBe("Las Vegas");
  });

  it("extracts work events", () => {
    const [event] = extractEvents(
      { role: "user", content: "I started working at NovaTech last Monday." },
      baseContext
    );
    expect(event.category).toBe("work");
    expect(event.what).toBe("started working at NovaTech");
  });

  it("extracts attendance events", () => {
    const [event] = extractEvents(
      { role: "user", content: "I attended the meetup in Taipei yesterday." },
      baseContext
    );
    expect(event.what).toBe("attended meetup");
    expect(event.category).toBe("events");
  });

  it("extracts watch/read/play events", () => {
    const [event] = extractEvents(
      { role: "user", content: "I finished reading Project Hail Mary in March." },
      baseContext
    );
    expect(event.what).toBe("finished reading Project Hail Mary");
    expect(event.category).toBe("entertainment");
    expect(event.ts_precision).toBe("month");
  });

  it("extracts problem events directly", () => {
    const [event] = extractEvents(
      { role: "user", content: "The deployment pipeline crashed yesterday." },
      baseContext
    );
    expect(event.what).toBe("The deployment pipeline problem");
    expect(event.detail).toContain("crashed");
  });

  it("supports Chinese acquisition patterns", () => {
    const [event] = extractEvents(
      { role: "user", content: "我買了新的鍵盤，昨天剛到。" },
      baseContext
    );
    expect(event.what).toContain("買了新的鍵盤");
    expect(event.ts_precision).toBe("relative");
  });

  it("supports Chinese travel patterns", () => {
    const [event] = extractEvents(
      { role: "user", content: "我去了東京參加會議。" },
      baseContext
    );
    expect(event.what).toContain("去了東京參加會議");
    expect(["travel", "events", "work"]).toContain(event.category);
  });

  it("supports Chinese start/join patterns", () => {
    const [event] = extractEvents(
      { role: "user", content: "我開始學西班牙文了。" },
      baseContext
    );
    expect(event.what).toContain("開始學西班牙文了");
  });

  it("keeps source_text verbatim", () => {
    const message = "I bought a Samsung Galaxy S22 on February 20th";
    const [event] = extractEvents({ role: "user", content: message }, baseContext);
    expect(event.source_text).toBe(message);
    expect(event.session_id).toBe("sess-1");
    expect(event.turn_index).toBe(4);
  });

  it("extracts strong viewpoints as standalone events", () => {
    const events = extractEvents(
      { role: "user", content: "I think microservices are overengineered for small teams." },
      baseContext
    );
    expect(events.some((event) => event.category === "viewpoint")).toBe(true);
    expect(events.find((event) => event.category === "viewpoint")?.detail).toContain("overengineered");
  });

  it("extracts Chinese viewpoints", () => {
    const events = extractEvents(
      { role: "user", content: "我覺得這個方案太複雜，維護成本很高。" },
      baseContext
    );
    expect(events.find((event) => event.category === "viewpoint")?.detail).toContain("太複雜");
  });

  it("captures standalone sentiment when no action event exists", () => {
    const [event] = extractEvents(
      { role: "user", content: "I'm really frustrated with the deployment process." },
      baseContext
    );
    expect(event.what).toBe("sentiment");
    expect(event.category).toBe("sentiment");
    expect(event.sentiment).toBe("frustrated");
  });

  it("creates both an event and a viewpoint when both are present", () => {
    const events = extractEvents(
      {
        role: "user",
        content: "I bought a MacBook yesterday. I think laptops with soldered SSDs are terrible.",
      },
      baseContext
    );
    expect(events.some((event) => event.category === "shopping")).toBe(true);
    expect(events.some((event) => event.category === "viewpoint")).toBe(true);
  });

  it("does not create viewpoint entries for weak opinions", () => {
    const events = extractEvents(
      { role: "user", content: "I think it's fine." },
      baseContext
    );
    expect(events).toEqual([]);
  });
});

describe("resolveDate", () => {
  it("resolves exact dates using session year", () => {
    expect(resolveDate("on March 14th", "exact", "2026-03-20T12:00:00.000Z")).toEqual({
      ts: "2026-03-14T00:00:00.000Z",
      precision: "exact",
    });
  });

  it("resolves last Tuesday relative to session date", () => {
    expect(resolveDate("last Tuesday", "relative", "2026-03-20T12:00:00.000Z")).toEqual({
      ts: "2026-03-17T00:00:00.000Z",
      precision: "day",
    });
  });

  it("resolves about a month ago as relative", () => {
    expect(resolveDate("about a month ago", "relative", "2026-03-20T12:00:00.000Z")).toEqual({
      ts: "2026-02-20T00:00:00.000Z",
      precision: "relative",
    });
  });

  it("resolves month references", () => {
    expect(resolveDate("in March", "month", "2026-03-20T12:00:00.000Z")).toEqual({
      ts: "2026-03-01T00:00:00.000Z",
      precision: "month",
    });
  });

  it("falls back to session date when unparseable", () => {
    expect(resolveDate("sometime soon", "exact", "2026-03-20T12:00:00.000Z")).toEqual({
      ts: "2026-03-20T00:00:00.000Z",
      precision: "relative",
    });
  });
});
