import { useEffect, useId, useRef, useState } from "react"

// mermaid pulls in d3 + dagre-layout + every diagram-type parser, ~1-2MB
// unminified -- dynamic import() so it only ever loads for a message that
// actually contains a ```mermaid fence, not on every page load.
async function renderMermaid(id: string, chart: string): Promise<string> {
  const { default: mermaid } = await import("mermaid")
  mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" })
  const { svg } = await mermaid.render(id, chart)
  return svg
}

// Streamed model output means `chart` mutates on every token until the
// fence closes -- debounce so we're not re-parsing (and flashing an error
// for) every partial, syntactically-invalid intermediate state.
const RENDER_DEBOUNCE_MS = 400

export function MermaidDiagram({ chart }: { chart: string }) {
  const id = useId().replace(/[:R]/g, "")
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const timeout = setTimeout(() => {
      renderMermaid(`mermaid-${id}`, chart)
        .then((svg) => {
          if (!cancelled && containerRef.current) {
            containerRef.current.innerHTML = svg
            setError(null)
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "Failed to render diagram")
          }
        })
    }, RENDER_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timeout)
    }
  }, [chart, id])

  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
        <p className="mb-1 font-medium">Couldn't render this diagram</p>
        <pre className="whitespace-pre-wrap">{error}</pre>
      </div>
    )
  }

  return <div ref={containerRef} className="[&_svg]:mx-auto [&_svg]:max-w-full" />
}
