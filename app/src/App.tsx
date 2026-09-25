import { Plus, Send } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Textarea } from "@/components/ui/textarea"

function App() {
  return (
    <div className="flex h-svh bg-background text-foreground">
      <aside className="flex w-64 flex-col border-r border-border">
        <div className="flex items-center justify-between p-3">
          <span className="text-sm font-medium">Threads</span>
          <Button size="icon" variant="ghost" aria-label="New thread">
            <Plus className="size-4" />
          </Button>
        </div>
        <Separator />
        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-1 p-2 text-sm text-muted-foreground">
            <button className="rounded-md px-2 py-1.5 text-left hover:bg-accent hover:text-accent-foreground">
              New chat
            </button>
          </div>
        </ScrollArea>
      </aside>

      <main className="flex flex-1 flex-col">
        <ScrollArea className="flex-1">
          <div className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
            <p className="text-sm text-muted-foreground">Start a conversation.</p>
          </div>
        </ScrollArea>

        <div className="border-t border-border p-4">
          <form
            className="mx-auto flex max-w-2xl items-end gap-2"
            onSubmit={(e) => e.preventDefault()}
          >
            <Textarea placeholder="Message..." className="min-h-11 flex-1 resize-none" rows={1} />
            <Button type="submit" size="icon" aria-label="Send message">
              <Send className="size-4" />
            </Button>
          </form>
        </div>
      </main>
    </div>
  )
}

export default App
