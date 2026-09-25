import { useCallback, useEffect, useRef, useState } from "react"
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
import { Message, MessageContent } from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"

interface Thread {
  id: string
  title: string
  created_at: number
  updated_at: number
}

interface ChatMessage {
  id: string
  thread_id: string
  role: "user" | "assistant" | "system"
  content: string
  created_at: number
}

function socketUrl(threadId: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${location.host}/api/threads/${threadId}/ws`
}

function App() {
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [connected, setConnected] = useState(false)
  const socketRef = useRef<WebSocket | null>(null)

  const selectThread = useCallback(async (threadId: string) => {
    setActiveThreadId(threadId)
    const res = await fetch(`/api/threads/${threadId}/messages`)
    setMessages(await res.json())
  }, [])

  // Load the thread list once; auto-create the first thread if there are none.
  useEffect(() => {
    fetch("/api/threads")
      .then((res) => res.json())
      .then(async (initialThreads: Thread[]) => {
        if (initialThreads.length === 0) {
          const res = await fetch("/api/threads", { method: "POST" })
          const thread: Thread = await res.json()
          setThreads([thread])
          selectThread(thread.id)
          return
        }
        setThreads(initialThreads)
        selectThread(initialThreads[0].id)
      })
  }, [selectThread])

  // Open a WebSocket to the active thread; tear it down on thread switch/unmount.
  useEffect(() => {
    if (!activeThreadId) {
      return
    }

    const ws = new WebSocket(socketUrl(activeThreadId))
    socketRef.current = ws

    ws.addEventListener("open", () => setConnected(true))
    ws.addEventListener("close", () => setConnected(false))
    ws.addEventListener("message", (event) => {
      const message: ChatMessage = JSON.parse(event.data)
      setMessages((prev) => [...prev, message])
    })

    return () => {
      ws.close()
      socketRef.current = null
    }
  }, [activeThreadId])

  const handleNewThread = async () => {
    const res = await fetch("/api/threads", { method: "POST" })
    const thread: Thread = await res.json()
    setThreads((prev) => [thread, ...prev])
    selectThread(thread.id)
  }

  const handleSubmit = (message: PromptInputMessage) => {
    if (!message.text.trim() || !socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      return
    }
    socketRef.current.send(JSON.stringify({ content: message.text }))
  }

  const activeThread = threads.find((t) => t.id === activeThreadId)

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center justify-between px-1 py-1">
            <span className="text-sm font-semibold">Threads</span>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label="New thread"
              onClick={handleNewThread}
            >
              <MessageSquarePlus className="size-4" />
            </Button>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {threads.map((thread) => (
                  <SidebarMenuItem key={thread.id}>
                    <SidebarMenuButton
                      isActive={thread.id === activeThreadId}
                      onClick={() => selectThread(thread.id)}
                    >
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
          <span className="text-sm text-muted-foreground">
            {activeThread?.title ?? "Loading…"}
          </span>
        </header>

        <Conversation>
          <ConversationContent>
            {messages.length === 0 ? (
              <ConversationEmptyState
                title="Start a conversation"
                description="Send a message to begin"
              />
            ) : (
              messages.map((message) => (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    <p className="whitespace-pre-wrap">{message.content}</p>
                  </MessageContent>
                </Message>
              ))
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="border-t border-border p-4">
          <PromptInput onSubmit={handleSubmit} className="mx-auto max-w-2xl">
            <PromptInputBody>
              <PromptInputTextarea
                placeholder={connected ? "Message…" : "Connecting…"}
                disabled={!connected}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools />
              <PromptInputSubmit status={connected ? "ready" : "submitted"} disabled={!connected} />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

export default App
