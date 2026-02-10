// Main React application component
// TODO: Define app routing and layout structure
import { useEffect, useState } from "react";
import { checkHealth } from "./api/client";

function App() {
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading");

  useEffect(() => {
    checkHealth()
      .then(() => setStatus("ok"))
      .catch(() => setStatus("error"));
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <h1>Bitcorn Lightning</h1>
      {status === "loading" && <p>Checking API…</p>}
      {status === "ok" && <p>✅ API is healthy</p>}
      {status === "error" && <p>❌ API unreachable</p>}
    </div>
  );
}

export default App;
