// ColdStartSpinner — single-line spinner per spec amendment §10.
//
// Used during initial cold-start backfill (after registering a new wallet
// or during a larger-than-incremental sync). No progress estimation, no
// chunked-progress bar, no "backfilling N of M blocks" text.
//
// v1 assumption: contract age << 6 months → cold-start under ~30 seconds.
// If/when the cold-start window grows past ~10 seconds the spec
// amendment's §10 prescribes revisiting this with chunked-progress UI;
// for now, simple beats clever.

export default function ColdStartSpinner({
  message = "Loading settlement history…",
}: {
  message?: string;
}) {
  return (
    <div className="stablecoin-spinner">
      <div className="sub-pulsing-dots" aria-hidden>
        <span /><span /><span />
      </div>
      <p className="stablecoin-spinner-text">{message}</p>
    </div>
  );
}
