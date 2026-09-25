import { MessageSquarePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"

const THREADS = [{ id: "1", title: "New chat" }]

function App() {
  const handleSubmit = (message: PromptInputMessage) => {
    // TODO: wire up once the Worker/D1/Durable Object chat endpoint exists
    console.log(message)
  }

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center justify-between px-1 py-1">
            <span className="text-sm font-semibold">Threads</span>
            <Button size="icon" variant="ghost" className="size-7" aria-label="New thread">
              <MessageSquarePlus className="size-4" />
            </Button>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {THREADS.map((thread) => (
                  <SidebarMenuItem key={thread.id}>
                    <SidebarMenuButton isActive={thread.id === "1"}>
                      {thread.title}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>

      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
          <SidebarTrigger />
          <span className="text-sm text-muted-foreground">New chat</span>
        </header>

        <Conversation>
          <ConversationContent>
            <ConversationEmptyState
              title="Start a conversation"
              description="Send a message to begin"
            />
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="border-t border-border p-4">
          <PromptInput onSubmit={handleSubmit} className="mx-auto max-w-2xl">
            <PromptInputBody>
              <PromptInputTextarea />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools />
              <PromptInputSubmit status="ready" />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App
