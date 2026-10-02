// Three dots that pulse in sequence.
//
// The existing .spinner is a rotating ring, which is right for a job that is
// finishing and wrong for one where the honest answer is "still going, no news".
// Dots read as that, and cost no motion budget.

export default function LoadingDots({ label = "Working" }: { label?: string }) {
  return (
    <span
      aria-label={label}
      role="status"
      style={{ display: "inline-flex", alignItems: "center", gap: "4px", marginLeft: "0.5rem" }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          aria-hidden="true"
          style={{
            width: "5px",
            height: "5px",
            borderRadius: "50%",
            background: "currentColor",
            animation: `dotPulse 1.2s ease-in-out ${i * 0.2}s infinite`,
          }}
        />
      ))}
    </span>
  );
}
