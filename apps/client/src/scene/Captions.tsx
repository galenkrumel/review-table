// Caption bar — surfaces dialogue text alongside audio so the review is followable
// with sound off (FR-14). Empty in M0; fed by `text_delta` streaming in M2.

export function Captions({ text }: { text?: string | null }) {
  return (
    <div className="captions">
      {text ? <p>{text}</p> : <p className="captions-empty">captions appear here</p>}
    </div>
  );
}
