"use client";

/**
 * One labelled on/off switch, with a sentence saying what turning it off does.
 *
 * The help text is not decoration. These are the first settings on this page whose
 * effect is on the page a listener sees rather than in the dashboard, so the only
 * way an operator can act on "what does this actually do?" is to be told — the
 * player has no admin panel to check it against. Each one names the specific chip
 * it controls, because all three sit in the same place in the header and "the
 * header" is not a description.
 *
 * Styled to match the switch already used for the Explicit tag, the Support
 * button and maintenance mode, so every toggle in the admin reads the same.
 */
export default function HeaderToggle({
  id,
  label,
  help,
  on,
  onToggle,
}: {
  id: string;
  label: string;
  help: string;
  on: boolean;
  onToggle: () => void;
}) {
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;

  return (
    <div style={{ maxWidth: "520px" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "1rem",
        }}
      >
        <span id={labelId} style={{ fontSize: "0.9rem" }}>
          {label}
        </span>
        <button
          id={id}
          role="switch"
          aria-checked={on}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          onClick={onToggle}
          style={{
            flexShrink: 0,
            width: "48px",
            height: "27px",
            borderRadius: "999px",
            border: "none",
            cursor: "pointer",
            backgroundColor: on ? "var(--color-accent)" : "rgba(255,255,255,0.18)",
            position: "relative",
            transition: "background-color 0.2s ease",
            padding: 0,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: "2px",
              left: on ? "23px" : "2px",
              width: "23px",
              height: "23px",
              borderRadius: "50%",
              backgroundColor: "#fff",
              transition: "left 0.2s ease",
            }}
          />
        </button>
      </div>
      <div id={helpId} style={{ fontSize: "0.8rem", color: "var(--color-muted)", marginTop: "0.3rem" }}>
        {help}
      </div>
    </div>
  );
}
