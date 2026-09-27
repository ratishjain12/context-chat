import { useState } from "react"
import { Eye, Brain, Wrench, ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { MODELS, findModel, type ModelOption } from "@shared/models"

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

export function ModelPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const current = findModel(value)

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="gap-1.5 text-muted-foreground"
        onClick={() => setOpen(true)}
      >
        {current ? shortName(current.id) : value}
        <ChevronsUpDown className="size-3.5" />
      </Button>

      <CommandDialog open={open} onOpenChange={setOpen} title="Select a model" description="Search models...">
        <Command>
          <CommandInput placeholder="Search models..." />
          <CommandList>
            <CommandEmpty>No models found.</CommandEmpty>
            {Object.entries(groups).map(([provider, models]) => (
              <CommandGroup key={provider} heading={provider}>
                {models?.map((model) => (
                  <CommandItem
                    key={model.id}
                    value={`${model.id} ${model.description}`}
                    onSelect={() => {
                      onChange(model.id)
                      setOpen(false)
                    }}
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
                    {formatPrice(model) && (
                      <p className="text-xs text-muted-foreground/70">{formatPrice(model)}</p>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  )
}
