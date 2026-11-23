// A sentence whose amounts never break inside themselves (G3 ruling R2): each
// occurrence of an amount's text is wrapped in .sub-amount, in place, so the
// words are unchanged. Longest first, so "$X (N sats)" wins over its "$X".

export function Sentence({ text, amounts }: { text: string; amounts: string[] }) {
  const list = [...new Set(amounts.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (list.length === 0) return <>{text}</>;
  const re = new RegExp(`(${list.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`);
  return (
    <>
      {text.split(re).map((part, i) => (list.includes(part) ? <span key={i} className="sub-amount">{part}</span> : part))}
    </>
  );
}
