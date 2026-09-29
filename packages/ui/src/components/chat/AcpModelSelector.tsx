import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useAcpModelStore } from '@/stores/useAcpModelStore';
import { AcpBackendBadge } from './AcpBackendBadge';
import { cn } from '@/lib/utils';

/**
 * Store key for the new-session composer, where no session exists yet. The
 * server remembers the chosen model and applies it to every session the agent
 * creates, so a selection made here lands on the session that starts.
 */
const NEW_SESSION_KEY = 'acp-new-session';

/**
 * Composer model picker for the ACP backend.
 *
 * Lists the models the agent reported (session/new `configOptions`, category
 * `model`) and switches the model through the agent connection. It works both
 * with a selected session and in the new-session composer. When the agent
 * reports no model select, or the list cannot be loaded, it falls back to
 * {@link AcpBackendBadge} so the composer never claims an OpenCode model the
 * ACP turn is not using.
 */
export const AcpModelSelector: React.FC<{ sessionId: string | null; className?: string }> = ({
  sessionId,
  className,
}) => {
  const storeKey = sessionId ?? NEW_SESSION_KEY;
  const config = useAcpModelStore((state) => state.bySession[storeKey]);
  const loading = useAcpModelStore((state) => state.loading[storeKey]);
  const load = useAcpModelStore((state) => state.load);
  const select = useAcpModelStore((state) => state.select);

  React.useEffect(() => {
    void load(storeKey);
  }, [load, storeKey]);

  if (!config && !loading) {
    return <AcpBackendBadge className={className} />;
  }

  if (!config) {
    return (
      <div className={cn('flex min-w-0 items-center gap-1.5 typography-meta text-muted-foreground', className)}>
        <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin" />
      </div>
    );
  }

  const current = config.options.find((option) => option.value === config.currentValue) ?? config.options[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex min-w-0 cursor-pointer select-none items-center gap-1.5 hover:opacity-70 data-[popup-open]:opacity-70',
            className,
          )}
        >
          <Icon name="terminal-box" className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium text-foreground">{current.name}</span>
          <Icon name="arrow-down-s" className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        alignOffset={-40}
        collisionAvoidance={{ side: 'none', align: 'shift' }}
        className="w-[min(280px,calc(100vw-2rem))]"
      >
        {config.options.map((option) => {
          const selected = option.value === config.currentValue;
          return (
            <DropdownMenuItem
              key={option.value}
              className="typography-meta gap-2"
              onSelect={() => {
                if (!selected) void select(storeKey, option.value);
              }}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {selected ? <Icon name="check" className="size-3.5 text-primary" /> : null}
              </span>
              <span className="truncate">{option.name}</span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
