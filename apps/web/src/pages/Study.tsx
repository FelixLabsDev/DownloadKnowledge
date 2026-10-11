import type { Rating, StudyCard, StudyStep } from '@dk/core';
import { ArrowLeft, EyeOff, MoreVertical, Pencil, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CardView } from '@/components/CardView';
import { Button, Menu, useToast } from '@/components/ui';
import { api } from '@/db/client';
import { cn, formatInterval } from '@/lib/utils';

const RATINGS: { rating: Rating; label: string; color: string }[] = [
  { rating: 1, label: 'Again', color: 'text-rate-again' },
  { rating: 2, label: 'Hard', color: 'text-rate-hard' },
  { rating: 3, label: 'Good', color: 'text-rate-good' },
  { rating: 4, label: 'Easy', color: 'text-rate-easy' },
];

interface View {
  card: StudyCard | null;
  counts: StudyStep['counts'] | null;
  waitUntil: number | null;
  /** Cram only: cards left, including the one shown. */
  remaining?: number;
}

export function StudyPage() {
  const { deckId = '' } = useParams();
  const [params] = useSearchParams();
  const cram = params.get('cram') === '1';
  const navigate = useNavigate();
  const { toast, fail } = useToast();

  const [view, setView] = useState<View | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [deckName, setDeckName] = useState('');
  const [answered, setAnswered] = useState(0);
  const shownAt = useRef(Date.now());
  const cramQueue = useRef<string[] | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (cram) {
      cramQueue.current ??= await api.cramCardIds(deckId);
      const id = cramQueue.current[0];
      setView({ card: id ? await api.renderCardById(id) : null, counts: null, waitUntil: null, remaining: cramQueue.current.length });
    } else {
      const step = await api.nextStudyStep(deckId);
      setView({ card: step.card, counts: step.counts, waitUntil: step.waitUntil });
    }
    setRevealed(false);
    shownAt.current = Date.now();
  }, [cram, deckId]);

  useEffect(() => {
    cramQueue.current = null;
    api.getDeck(deckId).then((d) => setDeckName(d.name), fail);
    load().catch(fail);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, deckId]);

  // While waiting on a learning card, look again as soon as it is due.
  useEffect(() => {
    if (!view?.waitUntil) return;
    const t = setTimeout(() => load().catch(fail), Math.max(1000, view.waitUntil - Date.now()));
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.waitUntil, load]);

  const guard = async (fn: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      busy.current = false;
    }
  };

  const answer = (rating: Rating) =>
    guard(async () => {
      if (!view?.card || !revealed) return;
      if (cram) {
        const [id, ...rest] = cramQueue.current ?? [];
        // "Again" sends the card to the back of the cram queue; nothing is written.
        cramQueue.current = rating === 1 && id ? [...rest, id] : rest;
      } else {
        await api.answerCard(view.card.card.id, rating, Date.now() - shownAt.current);
      }
      setAnswered((n) => n + 1);
      await load();
    });

  const undo = () =>
    guard(async () => {
      const card = await api.undoLastReview();
      if (!card) {
        toast('Nothing to undo.');
        return;
      }
      setAnswered((n) => Math.max(0, n - 1));
      await load();
    });

  const suspend = () =>
    guard(async () => {
      if (!view?.card) return;
      const id = view.card.card.id;
      await api.setSuspended([id], true);
      if (cram) cramQueue.current = (cramQueue.current ?? []).filter((x) => x !== id);
      toast('Card suspended.', { label: 'Undo', run: () => void api.setSuspended([id], false).then(load, fail) });
      await load();
    });

  const onKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable]')) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (!revealed) setRevealed(true);
        else void answer(3);
      } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        void answer(Number(e.key) as Rating);
      } else if (e.key === 'z' && !cram) {
        void undo();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revealed, view, cram],
  );

  useEffect(() => {
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onKey]);

  const card = view?.card ?? null;
  const now = Date.now();

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col" data-testid="study">
      <header className="flex items-center gap-2 border-b px-2 py-2">
        <Button variant="ghost" size="icon" aria-label="Back to decks" onClick={() => navigate('/')}>
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{deckName}</div>
          {cram && <div className="text-xs text-muted-foreground">Cram: your schedule is not changed</div>}
        </div>
        {view?.counts && (
          <div className="flex gap-3 text-sm tabular-nums" data-testid="counts">
            <span className="text-state-new" title="New">{view.counts.new}</span>
            <span className="text-state-learning" title="Learning">{view.counts.learning}</span>
            <span className="text-state-review" title="To review">{view.counts.review}</span>
          </div>
        )}
        {cram && view && <div className="text-sm tabular-nums text-muted-foreground">{view.remaining} left</div>}
        {!cram && (
          <Button variant="ghost" size="icon" aria-label="Undo last review" onClick={() => void undo()}>
            <Undo2 />
          </Button>
        )}
        <Menu
          label="Card actions"
          trigger={<MoreVertical />}
          items={[
            { label: 'Edit note', icon: <Pencil />, disabled: !card, onSelect: () => card && navigate(`/note/${card.noteId}`) },
            { label: 'Suspend card', icon: <EyeOff />, disabled: !card, onSelect: () => void suspend() },
          ]}
        />
      </header>

      {view && !card && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          {view.waitUntil ? (
            <>
              <h1 className="text-xl font-semibold">Short break</h1>
              <p className="text-muted-foreground">
                The next card is due in {formatInterval(view.waitUntil - now)}. It will appear here on its own.
              </p>
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold" data-testid="done">{cram ? 'Cram finished' : 'Done for today'}</h1>
              <p className="text-muted-foreground">
                {answered > 0 ? `You answered ${answered} ${answered === 1 ? 'card' : 'cards'}.` : 'Nothing is due in this deck right now.'}
              </p>
            </>
          )}
          <div className="mt-2 flex gap-2">
            <Button variant="outline" onClick={() => navigate('/')}>Back to decks</Button>
            {!cram && !view.waitUntil && (
              <Link to={`/study/${deckId}?cram=1`}>
                <Button variant="ghost">Cram this deck</Button>
              </Link>
            )}
          </div>
        </div>
      )}

      {card && (
        <>
          {card.warnings.length > 0 && (
            <div className="border-b bg-muted px-4 py-1.5 text-xs text-muted-foreground" role="note">
              {card.warnings.join(' ')}
            </div>
          )}
          <div className="min-h-0 flex-1">
            <CardView
              html={revealed ? card.back : card.front}
              css={card.css}
              onTap={() => !revealed && setRevealed(true)}
              onSwipe={(dir) => (revealed ? void answer(dir === 'left' ? 1 : 3) : setRevealed(true))}
              onKey={onKey}
            />
          </div>
          <footer className="border-t p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {!revealed ? (
              <Button size="lg" className="h-16 w-full text-lg" onClick={() => setRevealed(true)}>
                Show answer
              </Button>
            ) : (
              <div className="grid grid-cols-4 gap-2">
                {RATINGS.map(({ rating, label, color }) => (
                  <button
                    key={rating}
                    onClick={() => void answer(rating)}
                    className="flex h-16 flex-col items-center justify-center rounded-lg border bg-card hover:bg-muted active:bg-muted"
                  >
                    <span className={cn('text-base font-semibold', color)}>{label}</span>
                    {!cram && <span className="text-xs text-muted-foreground">{formatInterval(card.nextDue[rating] - now)}</span>}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-2 hidden text-center text-xs text-muted-foreground md:block">
              Space shows the answer, 1–4 rate it{cram ? '' : ', Z undoes'}.
            </p>
            <p className="mt-2 text-center text-xs text-muted-foreground md:hidden">
              {revealed ? 'Swipe left for Again, right for Good.' : 'Tap the card to show the answer.'}
            </p>
          </footer>
        </>
      )}
    </div>
  );
}
