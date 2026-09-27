import { useEffect, useMemo, useRef, useState } from "react"
import { defaultFilter } from "cmdk"
import { Eye, Brain, Wrench, ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { MODELS, findModel, type ModelOption } from "@shared/models"

function keywordsFor(model: ModelOption): string[] {
  const keywords = [model.provider]
  if (model.vision) keywords.push("vision", "multimodal", "image")
  if (model.reasoning) keywords.push("reasoning")
  if (model.functionCalling) keywords.push("function calling", "tools", "agentic")
  return keywords
}

// Ranks a match on the model's own id (e.g. "glm" -> glm-5.3-flash) above a
// match that only hits its keywords. Sorted ourselves with shouldFilter=false
// on <Command> -- cmdk's own group/item DOM reordering on score turned out
// unreliable in practice, so we compute the order and just render that.
function scoreModel(model: ModelOption, search: string): number {
  const idScore = defaultFilter(model.id, search)
  if (idScore > 0) {
    return idScore
  }
  return defaultFilter(keywordsFor(model).join(" "), search) * 0.5
}

function shortName(id: string): string {
  return id.split("/").pop() ?? id
}

function formatPrice(model: ModelOption): string | null {
  if (model.pricePerMInput == null || model.pricePerMOutput == null) {
    return null
  }
  return `$${model.pricePerMInput}/M in · $${model.pricePerMOutput}/M out`
}

function formatContext(contextWindow: number | null): string | null {
  if (!contextWindow) {
    return null
  }
  return contextWindow >= 1000 ? `${Math.round(contextWindow / 1000)}K ctx` : `${contextWindow} ctx`
}

const groups = MODELS.reduce<Record<string, ModelOption[]>>((acc, model) => {
  ;(acc[model.provider] ??= []).push(model)
  return acc
}, {})

function ModelRow({ model, onSelect }: { model: ModelOption; onSelect: () => void }) {
  return (
    <CommandItem
      value={model.id}
      onSelect={onSelect}
      className="flex flex-col items-start gap-0.5 py-2"
    >
      <div className="flex w-full items-center gap-2">
        <span className="font-medium text-foreground">{shortName(model.id)}</span>
        <span className="flex items-center gap-1 text-muted-foreground">
          {model.vision && <Eye className="size-3.5" aria-label="Vision" />}
          {model.reasoning && <Brain className="size-3.5" aria-label="Reasoning" />}
          {model.functionCalling && <Wrench className="size-3.5" aria-label="Function calling" />}
        </span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {formatContext(model.contextWindow)}
        </span>
      </div>
      <p className="line-clamp-1 text-xs text-muted-foreground">{model.description}</p>
      {formatPrice(model) && <p className="text-xs text-muted-foreground/70">{formatPrice(model)}</p>}
    </CommandItem>
  )
}

export function ModelPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState("")
  const listRef = useRef<HTMLDivElement>(null)
  const current = findModel(value)

  const searchResults = useMemo(() => {
    if (!search.trim()) {
      return null
    }
    return MODELS.map((model) => ({ model, score: scoreModel(model, search) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.model)
  }, [search])

  // The results list is the same scrollable DOM node across re-renders, so
  // without this it stays scrolled wherever the previous (longer) result
  // set left it -- the new top match ends up above the fold instead of
  // visible right away.
  useEffect(() => {
    listRef.current?.querySelector("[cmdk-list]")?.scrollTo({ top: 0 })
  }, [search, open])

  function selectModel(id: string) {
    onChange(id)
    setOpen(false)
    setSearch("")
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch("")
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
        >
          {current ? shortName(current.id) : value}
          <ChevronsUpDown className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-96 p-0" ref={listRef}>
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search models..." value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            {searchResults ? (
              searchResults.map((model) => (
                <ModelRow key={model.id} model={model} onSelect={() => selectModel(model.id)} />
              ))
            ) : (
              Object.entries(groups).map(([provider, models]) => (
                <CommandGroup key={provider} heading={provider}>
                  {models.map((model) => (
                    <ModelRow key={model.id} model={model} onSelect={() => selectModel(model.id)} />
                  ))}
                </CommandGroup>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
