export default async function Blocked({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c } = await searchParams;
  return (
    <div className="stack-3" style={{ maxWidth: 560 }}>
      <h1>NeroX is not available in your region</h1>
      <p className="muted">
        NeroX cannot offer NRX or sNRX in {c ? <span className="mono">{c}</span> : "your country"} during the capped beta. This follows our
        legal review of payment-stablecoin rules and sanctions.
      </p>
      <p className="small">
        If you think this is wrong, for example because you use a VPN, switch it off and reload. Demo: clear with{" "}
        <a href="/?geo=GB">/?geo=GB</a>.
      </p>
    </div>
  );
}
