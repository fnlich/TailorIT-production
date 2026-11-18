import { AuthGate } from '@/components/shell/AuthGate';
import { AuthProvider } from '@/lib/auth';

/** Full-screen editors: no sidebar or top bar; each editor draws its own EditorBar over the low surface. */
export default function EditorLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <div className="flex min-h-dvh flex-col bg-surface-low">
        <AuthGate>{children}</AuthGate>
      </div>
    </AuthProvider>
  );
}
