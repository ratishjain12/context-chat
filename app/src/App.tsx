import { useCallback, useEffect, useRef, useState } from "react"
import { MessageSquarePlus, Paperclip, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
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
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input"
import { ModelPicker } from "@/components/model-picker"
import { ACCEPTED_MIME_TYPES, ruleForFilename, type FileCategory } from "@shared/file-types"
import { DEFAULT_MODEL } from "@shared/models"

interface Thread {
  id: string
  title: string
  created_at: number
  updated_at: number
}

interface AttachmentInfo {
  id: string
  filename: string
  mime_type: string
  size_bytes: number
  category: FileCategory
}

interface ChatMessage {
  id: string
  thread_id: string
  role: "user" | "assistant" | "system"
  content: string
  model?: string | null
  created_at: number
  attachments?: AttachmentInfo[]
}

function socketUrl(threadId: string): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${location.host}/api/threads/${threadId}/ws`
}

// Lives inside <PromptInput> to reach its attachment context. Uploads each
// picked file to R2 as soon as it's added (not on send) -- the message that
// will reference it doesn't exist yet, so attachments start unlinked and get
// tied to a message id only once the chat message is actually sent.
function AttachmentBar({
  threadId,
  onChange,
}: {
  threadId: string
  onChange: (attachments: AttachmentInfo[]) => void
}) {
  const { files, remove, openFileDialog } = usePromptInputAttachments()
  const uploaded = useRef(new Map<string, AttachmentInfo>())
  const uploading = useRef(new Set<string>())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const currentIds = new Set(files.map((f) => f.id))
    for (const id of uploaded.current.keys()) {
      if (!currentIds.has(id)) {
        uploaded.current.delete(id)
      }
    }

    for (const file of files) {
      if (uploaded.current.has(file.id) || uploading.current.has(file.id)) {
        continue
      }

      const filename = file.filename ?? "upload"
      const rule = ruleForFilename(filename)
      if (!rule) {
        setError(`${filename}: unsupported file type`)
        remove(file.id)
        continue
      }

      uploading.current.add(file.id)

      fetch(file.url)
        .then((res) => res.blob())
        .then((blob) => {
          if (blob.size > rule.maxBytes) {
            throw new Error(`${filename}: too large (max ${Math.round(rule.maxBytes / (1024 * 1024))}MB)`)
          }
          return fetch(`/api/threads/${threadId}/attachments`, {
            method: "POST",
            headers: { "X-Filename": filename, "Content-Type": rule.mimeType },
            body: blob,
          })
        })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`${filename}: upload failed`)
          }
          return res.json()
        })
        .then((attachment: AttachmentInfo) => {
          setError(null)
          uploaded.current.set(file.id, attachment)
          onChange([...uploaded.current.values()])
        })
        .catch((err) => {
          setError(err instanceof Error ? err.message : `${filename}: upload failed`)
          remove(file.id)
        })
        .finally(() => {
          uploading.current.delete(file.id)
        })
    }

    onChange([...uploaded.current.values()])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files])

  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-8"
          aria-label="Attach file"
          onClick={openFileDialog}
        >
          <Paperclip className="size-4" />
        </Button>
        {files.map((file) => (
          <span
            key={file.id}
            className="flex items-center gap-1 rounded-full bg-secondary px-2 py-1 text-xs"
          >
            {file.filename}
            <button type="button" onClick={() => remove(file.id)} aria-label={`Remove ${file.filename}`}>
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      {error && <p className="px-1 text-xs text-destructive">{error}</p>}
    </div>
  )
}

function App() {
  const [threads, setThreads] = useState<Thread[]>([])
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [connected, setConnected] = useState(false)
  const [pendingAttachments, setPendingAttachments] = useState<AttachmentInfo[]>([])
  const [isGenerating, setIsGenerating] = useState(false)
  const [selectedModel, setSelectedModel] = useState(DEFAULT_MODEL)
  const [threadToDelete, setThreadToDelete] = useState<Thread | null>(null)
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
      const data:
        | { type: "message"; message: ChatMessage }
        | { type: "delta"; id: string; content: string }
        | { type: "thread_title"; threadId: string; title: string } = JSON.parse(event.data)

      if (data.type === "thread_title") {
        setThreads((prev) =>
          prev.map((t) => (t.id === data.threadId ? { ...t, title: data.title } : t))
        )
        return
      }

      if (data.type === "delta") {
        setIsGenerating(true)
        setMessages((prev) => {
          const idx = prev.findIndex((m) => m.id === data.id)
          if (idx === -1) {
            return [
              ...prev,
              {
                id: data.id,
                thread_id: activeThreadId,
                role: "assistant",
                content: data.content,
                created_at: Date.now(),
              },
            ]
          }
          const next = [...prev]
          next[idx] = { ...next[idx], content: next[idx].content + data.content }
          return next
        })
        return
      }

      const { message } = data
      if (message.role === "assistant") {
        setIsGenerating(false)
      }
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === message.id)
        if (idx === -1) {
          return [...prev, message]
        }
        const next = [...prev]
        next[idx] = message
        return next
      })
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

  const confirmDeleteThread = async () => {
    if (!threadToDelete) {
      return
    }
    const threadId = threadToDelete.id
    setThreadToDelete(null)

    await fetch(`/api/threads/${threadId}`, { method: "DELETE" })
    const remaining = threads.filter((t) => t.id !== threadId)
    setThreads(remaining)

    if (threadId !== activeThreadId) {
      return
    }

    if (remaining.length > 0) {
      selectThread(remaining[0].id)
      return
    }

    const res = await fetch("/api/threads", { method: "POST" })
    const thread: Thread = await res.json()
    setThreads([thread])
    selectThread(thread.id)
  }

  const handleSubmit = (message: PromptInputMessage) => {
    const hasText = message.text.trim().length > 0
    if ((!hasText && pendingAttachments.length === 0) || socketRef.current?.readyState !== WebSocket.OPEN) {
      return
    }
    socketRef.current.send(
      JSON.stringify({
        content: message.text,
        attachmentIds: pendingAttachments.map((a) => a.id),
        model: selectedModel,
      })
    )
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
                      <span>{thread.title}</span>
                    </SidebarMenuButton>
                    <SidebarMenuAction
                      showOnHover
                      className="cursor-pointer"
                      aria-label={`Delete ${thread.title}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setThreadToDelete(thread)
                      }}
                    >
                      <Trash2 />
                    </SidebarMenuAction>
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
                    {message.content && <MessageResponse>{message.content}</MessageResponse>}
                    {message.model && (
                      <span className="text-xs text-muted-foreground">
                        {message.model.split("/").pop()}
                      </span>
                    )}
                    {message.attachments?.map((attachment) => (
                      <a
                        key={attachment.id}
                        href={`/api/attachments/${attachment.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex w-fit items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Paperclip className="size-3" />
                        {attachment.filename}
                      </a>
                    ))}
                  </MessageContent>
                </Message>
              ))
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <div className="border-t border-border p-4">
          <PromptInput
            onSubmit={handleSubmit}
            multiple
            accept={ACCEPTED_MIME_TYPES}
            maxFileSize={20 * 1024 * 1024}
            className="mx-auto max-w-2xl"
          >
            <PromptInputHeader>
              {activeThreadId && (
                <AttachmentBar threadId={activeThreadId} onChange={setPendingAttachments} />
              )}
            </PromptInputHeader>
            <PromptInputBody>
              <PromptInputTextarea
                placeholder={connected ? "Message…" : "Connecting…"}
                disabled={!connected}
              />
            </PromptInputBody>
            <PromptInputFooter>
              <PromptInputTools>
                <ModelPicker value={selectedModel} onChange={setSelectedModel} />
              </PromptInputTools>
              <PromptInputSubmit
                status={!connected ? "submitted" : isGenerating ? "streaming" : "ready"}
                disabled={!connected}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </SidebarInset>

      <Dialog open={!!threadToDelete} onOpenChange={(open) => !open && setThreadToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete thread?</DialogTitle>
            <DialogDescription>
              "{threadToDelete?.title}" and all its messages will be permanently deleted. This
              can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setThreadToDelete(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDeleteThread}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarProvider>
  )
}

export default App
