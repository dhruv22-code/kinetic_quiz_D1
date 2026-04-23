import TopAppBar from "@/src/components/TopAppBar";
import BottomNavBar from "@/src/components/BottomNavBar";
import { Info, CheckCircle2, Loader2, AlertCircle, X, Bot } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import React, { useState, useEffect } from "react";
import { useQuiz, LOBBY_COUNTDOWN_SECONDS } from "@/src/context/QuizContext";
import { useNavigate, useBlocker } from "react-router-dom";
import { cn } from "@/src/lib/utils";
import { Rocket, Trophy, Clock } from "lucide-react";

import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import 'katex/dist/katex.min.css';

export default function StudentQuiz() {
  const { quiz, currentStudentRoll, updateParticipant, leaveLobby, participants, calculateScore, loading: quizLoading } = useQuiz();
  const navigate = useNavigate();
  
  const participant = participants.find(p => p.roll === currentStudentRoll);
  const currentQuestionIndex = participant?.progress ?? 0;

  // Lobby countdown state
  const [lobbyCountdown, setLobbyCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (quiz?.status === 'starting' && quiz.startedAt) {
      const startedAt = typeof quiz.startedAt === 'string' ? new Date(quiz.startedAt).getTime() : 
                        (quiz.startedAt.toMillis ? quiz.startedAt.toMillis() : Date.now());
      
      const interval = setInterval(() => {
        const now = Date.now();
        const elapsed = (now - startedAt) / 1000;
        const remaining = Math.max(0, Math.ceil(LOBBY_COUNTDOWN_SECONDS - elapsed));
        setLobbyCountdown(remaining);
        
        if (remaining <= 0) {
          clearInterval(interval);
        }
      }, 100);

      return () => clearInterval(interval);
    } else {
      setLobbyCountdown(null);
    }
  }, [quiz?.status, quiz?.startedAt]);
  
  // Get the current question based on shuffled order
  const currentQuestionId = participant?.questionOrder?.[currentQuestionIndex];
  const currentQuestion = quiz?.questions.find(q => q.id === currentQuestionId);
  
  const totalQuestions = participant?.questionOrder?.length || quiz?.questions.length || 0;
  const isLastQuestion = currentQuestionIndex === totalQuestions - 1;
  
  const [response, setResponse] = useState("");
  const [selectedOption, setSelectedOption] = useState<string | string[] | null>(null);
  const [wordCount, setWordCount] = useState(0);
  const [isFinished, setIsFinished] = useState(false);
  const [quizEnded, setQuizEnded] = useState(false);
  const [showLeaveWarning, setShowLeaveWarning] = useState(false);
  const [questionTimeLeft, setQuestionTimeLeft] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cheatAttempts, setCheatAttempts] = useState(0);
  const [showCheatWarning, setShowCheatWarning] = useState(false);
  const [isDisqualified, setIsDisqualified] = useState(false);
  const timeLeftRef = React.useRef<number | null>(null);
  const cheatAttemptsRef = React.useRef(0);

  useEffect(() => {
    cheatAttemptsRef.current = cheatAttempts;
  }, [cheatAttempts]);

  useEffect(() => {
    timeLeftRef.current = questionTimeLeft;
  }, [questionTimeLeft]);

  // Sync cheat attempts and disqualification status from database
  useEffect(() => {
    if (participant) {
      if (participant.cheatingAttempts !== undefined && participant.cheatingAttempts > cheatAttempts) {
        const incomingAttempts = participant.cheatingAttempts;
        setCheatAttempts(incomingAttempts);
        
        // Auto-show warning if they just re-entered with 1 strike
        if (incomingAttempts === 1 && !showCheatWarning && !isFinished && !isDisqualified) {
          setShowCheatWarning(true);
        }
      }
      if (participant.isDisqualified && !isDisqualified) {
        setIsDisqualified(true);
      }
    }
  }, [participant?.cheatingAttempts, participant?.isDisqualified]);

  // Internal Navigation Blocker (Detect going back or navigating away)
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      !isFinished && 
      !isDisqualified && 
      (quiz?.status === 'active' || quiz?.status === 'starting' || quiz?.status === 'waiting') &&
      currentLocation.pathname !== nextLocation.pathname
  );

  useEffect(() => {
    if (blocker.state === "blocked") {
      const triggerNavStrike = async () => {
        const newAttempts = cheatAttemptsRef.current + 1;
        setCheatAttempts(newAttempts);
        
        if (newAttempts === 1) {
          setShowCheatWarning(true);
          if (currentStudentRoll) {
            await updateParticipant(currentStudentRoll, { cheatingAttempts: 1 });
          }
          // We let them proceed (leave) because the user wants to allow "going outside and re-entering"
          blocker.proceed?.();
        } else {
          await handleDisqualification();
          blocker.proceed?.();
        }
      };
      triggerNavStrike();
    }
  }, [blocker.state, currentStudentRoll, isFinished, isDisqualified]);

  // Tab Exclusivity Check (BroadcastChannel prevents multiple tabs of the same user)
  useEffect(() => {
    if (!currentStudentRoll || isFinished || quizEnded) return;

    const channelName = `quiz_session_${currentStudentRoll}`;
    const channel = new BroadcastChannel(channelName);
    const tabId = Math.random().toString(36).substring(2);
    
    const handleMessage = (msg: MessageEvent) => {
      if (msg.data.type === 'ALIVE_CHECK' && msg.data.id !== tabId) {
        // Someone is checking if we are alive, tell them we are
        channel.postMessage({ type: 'I_AM_ALIVE', id: tabId });
      } else if (msg.data.type === 'I_AM_ALIVE' && msg.data.id !== tabId && !isFinished && !quizEnded) {
        // Someone else is already here and was here first
        console.warn("Multiple tabs detected for roll:", currentStudentRoll);
        navigate("/join?error=user already joined");
      }
    };

    channel.addEventListener('message', handleMessage);
    
    // Check for other tabs with a small delay to handle simultaneous duplication
    const checkTimeout = setTimeout(() => {
      channel.postMessage({ type: 'ALIVE_CHECK', id: tabId });
    }, Math.random() * 200 + 50);

    return () => {
      clearTimeout(checkTimeout);
      channel.removeEventListener('message', handleMessage);
      channel.close();
    };
  }, [currentStudentRoll, isFinished, quizEnded, navigate]);

  // Heartbeat to update lastSeen and check session integrity
  useEffect(() => {
    if (!currentStudentRoll || isFinished || quizEnded || isDisqualified || !participant) return;

    const heartbeat = setInterval(async () => {
      try {
        const localSessionToken = sessionStorage.getItem('sessionToken');
        
        // If we don't have a local token or it doesn't match the one we joined with,
        // it means this session is invalid or has been taken over.
        if (participant.sessionToken && localSessionToken && participant.sessionToken !== localSessionToken) {
           console.warn("Session takeover detected or invalid session. Ending current tab session.");
           navigate("/join?error=user already joined");
           return;
        }

        const updates: any = { lastSeen: Date.now() };
        if (currentQuestion && timeLeftRef.current !== null && quiz?.status === 'active') {
          updates.questionTimers = {
            ...(participant?.questionTimers || {}),
            [currentQuestion.id]: timeLeftRef.current
          };
        }
        await updateParticipant(currentStudentRoll, updates);
      } catch (err: any) {
        console.error("Heartbeat failed:", err);
      }
    }, 5000); // More frequent heartbeat (5 seconds) for tighter locking

    return () => clearInterval(heartbeat);
  }, [currentStudentRoll, isFinished, quizEnded, quiz?.status, participant?.sessionToken]);

  // Browser-level warning for refresh/close
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!isFinished && !isDisqualified) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isFinished, isDisqualified]);

  const isTrappedRef = React.useRef(false);

  // Cheat Prevention (Tab switching)
  useEffect(() => {
    if (!currentStudentRoll || isFinished || quizEnded || isDisqualified || (quiz?.status !== 'active' && quiz?.status !== 'starting' && quiz?.status !== 'waiting')) return;

    // History Trap: Push a dummy state so back-button triggers popstate instead of leaving immediately
    if (!isTrappedRef.current) {
      window.history.pushState(null, "", window.location.href);
      isTrappedRef.current = true;
    }

    const handleCheatAttempt = async () => {
      if (isFinished || quizEnded || isDisqualified || showCheatWarning) return;
      
      const newAttempts = cheatAttemptsRef.current + 1;
      setCheatAttempts(newAttempts);

      if (newAttempts === 1) {
        setShowCheatWarning(true);
        // Persist the first warning to database for re-entry situations
        if (currentStudentRoll) {
          await updateParticipant(currentStudentRoll, { cheatingAttempts: 1 });
        }
      } else if (newAttempts >= 2) {
        handleDisqualification();
      }
    };

    const handleVisibilityChange = () => {
      // Focus more on visibilityState for mobile reliability
      if (document.hidden || document.visibilityState === 'hidden') {
        handleCheatAttempt();
      }
    };

    const handleBlur = () => {
      // Blur is noisy but catches window switching
      // Add a tiny delay to ignore temporary focus flutters
      setTimeout(() => {
        if (!document.hasFocus() && !showCheatWarning) {
          handleCheatAttempt();
        }
      }, 200);
    };

    const handlePopState = (e: PopStateEvent) => {
      // If we are in any joined state, block back navigation
      if (!isFinished && !isDisqualified && quiz?.status) {
        // If they hit back button, immediately push state again to "trap" them and trigger strike
        window.history.pushState(null, "", window.location.href);
        handleCheatAttempt();
      }
    };

    window.addEventListener('blur', handleBlur);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('blur', handleBlur);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('popstate', handlePopState);
    };
  }, [currentStudentRoll, isFinished, quizEnded, isDisqualified, quiz?.status, showCheatWarning]);

  const handleDisqualification = async () => {
    if (!currentStudentRoll || !participant || !quiz || isDisqualified) return;
    
    setIsDisqualified(true);
    setSubmitting(true);
    
    try {
      // Calculate score ONLY for questions BEFORE current one
      const questionsBefore = participant.questionOrder?.slice(0, currentQuestionIndex) || [];
      const filteredAnswers: Record<string, any> = {};
      
      // We only keep answers that were finalized before this question
      questionsBefore.forEach(id => {
        if (participant.answers[id]) {
          filteredAnswers[id] = participant.answers[id];
        }
      });

      const finalParticipant = { ...participant, answers: filteredAnswers };
      const score = calculateScore(finalParticipant, quiz, undefined, true);

      await updateParticipant(currentStudentRoll, {
        status: 'Submitted',
        answers: filteredAnswers,
        progress: currentQuestionIndex,
        isDisqualified: true,
        score,
        cheatingAttempts: 2
      });
      
      setIsFinished(true);
      navigate("/score?disqualified=true");
    } catch (err) {
      console.error("Disqualification failed:", err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleLeaveLobby = async () => {
    if (!currentStudentRoll) return;
    try {
      await leaveLobby(currentStudentRoll);
      navigate("/join");
    } catch (err) {
      console.error("Failed to leave lobby:", err);
    }
  };

  const handleLeaveQuiz = async () => {
    if (!currentStudentRoll || !participant) return;
    
    try {
      await updateParticipant(currentStudentRoll, { 
        status: 'Submitted',
        progress: currentQuestionIndex
      });
      setIsFinished(true);
      setShowLeaveWarning(false);
    } catch (err) {
      console.error("Failed to submit on leave:", err);
    }
  };

  const handleSubmit = async (isAutoAdvance = false) => {
    if (submitting || !currentStudentRoll || !quiz || !currentQuestion) return;
    setSubmitting(true);
    
    try {
      const answer = currentQuestion.type === "Paragraph" ? response : selectedOption;
      
      // Use the most up-to-date answers from the participant object
      const currentAnswers = participant?.answers || {};
      const updatedAnswers = { ...currentAnswers, [currentQuestion.id]: answer || "" };
      
      // Mark as expired if the timer actually ran out
      const updatedExpiries = {
        ...(participant?.questionExpiries || {}),
        [currentQuestion.id]: isAutoAdvance ? 0 : (participant?.questionExpiries?.[currentQuestion.id] || Date.now())
      };

      if (isLastQuestion) {
        const timeTaken = participant?.startTime ? Math.floor((Date.now() - participant.startTime) / 1000) : 0;
        
        // Calculate score (excluding paragraphs for initial student score)
        const finalParticipant = { ...participant!, answers: updatedAnswers };
        const score = calculateScore(finalParticipant, quiz, undefined, true);

        await updateParticipant(currentStudentRoll, { 
          status: 'Submitted',
          answers: updatedAnswers,
          questionExpiries: updatedExpiries,
          progress: currentQuestionIndex,
          timeTaken,
          score
        });
        setIsFinished(true);
        navigate("/score");
      } else {
        await updateParticipant(currentStudentRoll, { 
          status: 'Appearing',
          answers: updatedAnswers,
          questionExpiries: updatedExpiries,
          progress: currentQuestionIndex + 1
        });
      }
    } catch (err) {
      console.error("Submission failed:", err);
    } finally {
      setSubmitting(false);
    }
  };

  useEffect(() => {
    if (quiz?.status === 'active' && currentQuestion && !isFinished && !quizEnded && currentStudentRoll) {
      const now = Date.now();
      let expiry = participant?.questionExpiries?.[currentQuestion.id];
      
      // If no expiry set yet, set it now
      if (!expiry) {
        expiry = now + (currentQuestion.timer * 1000);
        updateParticipant(currentStudentRoll, {
          questionExpiries: {
            ...(participant?.questionExpiries || {}),
            [currentQuestion.id]: expiry
          }
        });
      }

      const calculateTimeLeft = () => {
        const remaining = Math.max(0, Math.floor((expiry! - Date.now()) / 1000));
        setQuestionTimeLeft(remaining);
        return remaining;
      };

      calculateTimeLeft();
      const timer = setInterval(() => {
        const remaining = calculateTimeLeft();
        if (remaining <= 0) {
          clearInterval(timer);
        }
      }, 1000);

      return () => clearInterval(timer);
    }
  }, [currentQuestionIndex, currentQuestion?.id, isFinished, quizEnded, currentStudentRoll, quiz?.status]);

  useEffect(() => {
    if (questionTimeLeft === 0 && !isFinished && !quizEnded && !submitting) {
      handleSubmit(true);
    }
  }, [questionTimeLeft, isFinished, quizEnded, submitting]);

  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    if (!quizLoading) {
      const timer = setTimeout(() => {
        setIsInitializing(false);
      }, 2000); // Give 2 seconds for participants to sync
      return () => clearTimeout(timer);
    }
  }, [quizLoading]);

  useEffect(() => {
    if (quizLoading || isInitializing) return;

    if (!quiz || !currentStudentRoll) {
      navigate("/join");
      return;
    }

    // Only redirect if we've given it time to sync and it's still missing
    if (!participant && !isInitializing) {
      console.warn("Participant record missing after sync period. Redirecting to join.");
      navigate("/join");
      return;
    }

    if (quiz && !quiz.isActive && !isFinished) {
      setQuizEnded(true);
    }
    if (participant?.status === 'Submitted') {
      navigate("/score");
    }
  }, [quiz, currentStudentRoll, navigate, quizLoading, isFinished, participant, isInitializing]);

  useEffect(() => {
    const words = response.trim().split(/\s+/).filter(word => word.length > 0);
    setWordCount(words.length);
  }, [response]);

  // Load existing answer when question changes
  useEffect(() => {
    if (!currentQuestion) return;
    
    const existingAnswer = participant?.answers?.[currentQuestion.id];
    if (currentQuestion.type === "Paragraph") {
      setResponse(typeof existingAnswer === 'string' ? existingAnswer : "");
    } else {
      setSelectedOption(existingAnswer || null);
    }
  }, [currentQuestionIndex, currentQuestion?.id]);

  const handleResponseChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setResponse(val);
  };

  // Debounced save for paragraph responses
  useEffect(() => {
    if (currentQuestion?.type !== "Paragraph" || !currentStudentRoll || !currentQuestion || isFinished || quizEnded || !participant) return;
    
    const timer = setTimeout(async () => {
      const currentAnswers = participant?.answers || {};
      // Only update if the answer has actually changed
      if (currentAnswers[currentQuestion.id] !== response) {
        await updateParticipant(currentStudentRoll, { 
          status: 'Appearing',
          answers: { ...currentAnswers, [currentQuestion.id]: response }
        });
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [response, currentQuestion?.id, currentStudentRoll, isFinished, quizEnded, participant]);

  const handleOptionSelect = async (optionId: string) => {
    if (isExpired || !participant) return;

    let nextOption: string | string[] | null = null;
    if (currentQuestion?.type === "Multiple Correct" || currentQuestion?.type === "MSQ") {
      const current = Array.isArray(selectedOption) ? selectedOption : [];
      nextOption = current.includes(optionId) 
        ? current.filter(id => id !== optionId) 
        : [...current, optionId];
      setSelectedOption(nextOption);
    } else {
      nextOption = optionId;
      setSelectedOption(optionId);
    }
    
    if (currentStudentRoll && currentQuestion) {
      const currentAnswers = participant?.answers || {};
      await updateParticipant(currentStudentRoll, { 
        status: 'Appearing',
        answers: { ...currentAnswers, [currentQuestion.id]: nextOption || "" }
      });
    }
  };

  if (quizLoading || (currentStudentRoll && !participant && isInitializing)) {
    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center gap-4">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <p className="text-on-surface-variant font-bold animate-pulse text-lg tracking-tight">Syncing session...</p>
        <p className="text-on-surface-variant/60 text-xs font-medium">Please wait while we connect you to the quiz.</p>
      </div>
    );
  }

  // Check if participant exists after loading
  if (!quiz || !currentStudentRoll || !participant) {
    if (isInitializing) return null;
    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center gap-6 p-6 text-center">
        <div className="w-16 h-16 bg-surface-container-high rounded-3xl flex items-center justify-center mx-auto shadow-sm">
           <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <div className="space-y-2">
          <p className="text-on-surface font-black text-2xl tracking-tight">Waiting for session sync...</p>
          <p className="text-on-surface-variant font-medium text-sm max-w-xs mx-auto">This usually takes a few seconds. If you're stuck, please try to rejoin.</p>
        </div>
        <button 
          onClick={() => navigate("/join")}
          className="px-8 py-3 bg-primary text-on-primary font-bold rounded-xl shadow-lg shadow-primary/20"
        >
          Back to Join Page
        </button>
      </div>
    );
  }

  if (quiz?.status === 'active' && (!currentQuestion || !quiz.questions || quiz.questions.length === 0)) {
    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center gap-6 p-6 text-center">
        <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto">
          <Bot className="w-10 h-10 text-primary animate-pulse" />
        </div>
        <div className="space-y-2">
          <p className="text-on-surface font-black text-2xl tracking-tight">Loading Question...</p>
          <p className="text-on-surface-variant font-medium text-sm">We're retrieving your dynamic question content.</p>
        </div>
        <div className="flex gap-1.5 justify-center">
          <div className="w-2 h-2 bg-primary/20 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
          <div className="w-2 h-2 bg-primary/20 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
          <div className="w-2 h-2 bg-primary/20 rounded-full animate-bounce"></div>
        </div>
      </div>
    );
  }

  if (quiz?.status === 'waiting' || (quiz?.status === 'starting' && lobbyCountdown !== null && lobbyCountdown > 0)) {
    return (
      <div className="bg-surface min-h-screen flex flex-col">
        <TopAppBar />
        <main className="flex-grow flex items-center justify-center p-6 relative overflow-hidden">
          <div className="absolute top-[-20%] right-[-10%] w-[50rem] h-[50rem] rounded-full bg-primary/5 blur-[120px] -z-10 animate-pulse"></div>
          
          <div className="w-full max-w-xl text-center">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-surface-container-lowest p-12 rounded-[4rem] shadow-2xl border border-outline-variant/10 relative"
            >
              <div className="w-24 h-24 bg-primary/10 rounded-3xl flex items-center justify-center mx-auto mb-8 relative">
                {quiz?.status === 'starting' ? (
                  <Rocket className="w-12 h-12 text-primary animate-bounce" />
                ) : (
                  <Clock className="w-12 h-12 text-primary animate-pulse" />
                )}
                {quiz?.status === 'starting' && (
                  <div className="absolute -top-2 -right-2 bg-error text-white w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm shadow-lg">
                    {lobbyCountdown}
                  </div>
                )}
              </div>

              <h2 className="font-headline text-4xl font-extrabold mb-4 tracking-tight">
                {quiz?.status === 'starting' ? "Get Ready!" : "Welcome to the Lobby"}
              </h2>
              <p className="text-on-surface-variant text-xl mb-12 font-medium">
                {quiz?.status === 'starting' 
                  ? "The quiz is about to begin. Entry is now locked." 
                  : "Waiting for your teacher to start the session..."}
              </p>

              <div className="space-y-6">
                <div className="flex flex-col items-center gap-2">
                   <div className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Joined Students</div>
                   <div className="flex -space-x-3 justify-center overflow-hidden py-2">
                     {participants.slice(0, 5).map((p, i) => {
                       const colors = [
                         'bg-blue-500', 'bg-purple-500', 'bg-emerald-500', 
                         'bg-orange-500', 'bg-rose-500', 'bg-indigo-500',
                         'bg-amber-500', 'bg-cyan-500'
                       ];
                       const colorClass = colors[i % colors.length];
                       const initial = p.name ? p.name.charAt(0).toUpperCase() : '?';
                       
                       return (
                         <motion.div
                           key={p.roll || `lobby-avatar-${i}`}
                           initial={{ scale: 0, x: 20 }}
                           animate={{ scale: 1, x: 0 }}
                           className={cn(
                             "inline-flex items-center justify-center h-12 w-12 rounded-full",
                             "ring-4 ring-surface-container-lowest text-white text-lg font-bold shadow-lg shrink-0",
                             colorClass
                           )}
                           title={p.name}
                         >
                           {initial}
                         </motion.div>
                       );
                     })}
                     
                     {participants.length > 5 && (
                       <motion.div 
                         initial={{ scale: 0 }}
                         animate={{ scale: 1 }}
                         className="inline-flex items-center justify-center h-12 w-12 rounded-full ring-4 ring-surface-container-lowest bg-surface-container-high text-on-surface text-sm font-bold shadow-lg z-10 shrink-0"
                       >
                         +{participants.length - 5}
                       </motion.div>
                     )}
                   </div>
                   <div className="text-center mt-1">
                     <p className="text-on-surface-variant text-[10px] font-bold uppercase tracking-widest leading-none">
                       {participants.length} {participants.length === 1 ? 'student' : 'students'} joined
                     </p>
                   </div>
                </div>

                {quiz?.status === 'starting' && (
                  <div className="w-full h-3 bg-surface-container-low rounded-full overflow-hidden mt-8">
                    <motion.div 
                      key="lobby-progress"
                      initial={{ width: "100%" }}
                      animate={{ width: "0%" }}
                      transition={{ duration: LOBBY_COUNTDOWN_SECONDS, ease: "linear" }}
                      className="h-full bg-primary"
                    />
                  </div>
                )}
              </div>

              {quiz?.status === 'waiting' && (
                <button 
                  onClick={handleLeaveLobby}
                  className="mt-12 text-on-surface-variant font-headline font-bold hover:text-error transition-colors flex items-center justify-center gap-2 mx-auto"
                >
                  <X className="w-4 h-4" />
                  Leave Quiz Room
                </button>
              )}
            </motion.div>
            
            <p className="mt-12 text-on-surface-variant font-medium flex items-center justify-center gap-2">
              <Info className="w-4 h-4 text-primary" />
              Quiz: <span className="font-bold text-on-surface">{quiz?.title}</span>
            </p>
          </div>
        </main>
        <BottomNavBar />
      </div>
    );
  }

  if (isFinished || quizEnded) {
    return (
      <div className="bg-surface min-h-screen flex flex-col items-center justify-center p-6 text-center">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-surface-container-lowest p-12 rounded-3xl shadow-xl border border-surface-container max-w-md w-full"
        >
          <div className="w-20 h-20 bg-secondary/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <Info className="w-10 h-10 text-primary" />
          </div>
          <h2 className="font-headline text-3xl font-extrabold mb-4 text-on-surface">
            Quiz Ended
          </h2>
          <p className="text-on-surface-variant mb-8 leading-relaxed">
            The quiz has been ended by the teacher. If you have any problems, please contact your teacher.
          </p>
          <button 
            onClick={() => navigate("/join")}
            className="w-full py-4 bg-primary text-on-primary font-headline font-bold rounded-xl shadow-lg shadow-primary/20 hover:scale-[1.02] active:scale-95 transition-all"
          >
            Back to Join Page
          </button>
        </motion.div>
      </div>
    );
  }

  if (!currentQuestion) {
    return (
      <div className="min-h-screen bg-surface flex flex-col items-center justify-center gap-4">
        <Loader2 className="w-10 h-10 animate-spin text-primary" />
        <p className="text-on-surface-variant font-medium">Reconnecting to question session...</p>
      </div>
    );
  }

  const progressPercent = ((currentQuestionIndex + 1) / totalQuestions) * 100;

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const isQuestionTimeLow = questionTimeLeft !== null && questionTimeLeft < 10;
  const isTimeLow = isQuestionTimeLow;
  const isExpired = questionTimeLeft === 0;

  return (
    <div className="bg-surface min-h-screen pb-24 flex flex-col pt-24 md:pt-28">
      <TopAppBar 
        variant="quiz" 
        progress={progressPercent} 
        currentTask={`Question ${currentQuestionIndex + 1} of ${totalQuestions}`} 
        timeLeft={questionTimeLeft !== null ? `${questionTimeLeft}s` : "..."} 
        timerProgress={questionTimeLeft !== null && currentQuestion ? (questionTimeLeft / currentQuestion.timer) * 100 : undefined}
        isLowTime={isTimeLow}
        onLogoClick={() => setShowLeaveWarning(true)}
      />

      {/* Cheating Warning Modal */}
      <AnimatePresence>
        {showCheatWarning && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/60 backdrop-blur-md">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="bg-surface rounded-[2.5rem] p-10 shadow-2xl border border-error/20 max-w-lg w-full text-center space-y-6"
            >
              <div className="w-20 h-20 bg-error/10 rounded-full flex items-center justify-center mx-auto">
                <AlertCircle className="w-10 h-10 text-error animate-pulse" />
              </div>
              <div className="space-y-2">
                <h3 className="font-headline text-3xl font-black text-on-surface">Cheating Warning!</h3>
                <p className="text-on-surface-variant font-medium text-lg leading-relaxed">
                  You switched tabs or minimized the window. This is strictly prohibited.
                </p>
              </div>
              <div className="bg-error/5 p-6 rounded-2xl border border-error/10">
                <p className="text-error font-bold">
                  {cheatAttempts === 1 
                    ? "This is your LAST warning. Repeating this will result in immediate disqualification." 
                    : "You are being disqualified."}
                </p>
              </div>
              <button 
                onClick={() => setShowCheatWarning(false)}
                className="w-full py-4 bg-error text-white font-headline font-bold rounded-xl shadow-lg shadow-error/20 hover:scale-[1.02] active:scale-95 transition-all"
              >
                I Understand
              </button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      
      <main className="flex-grow flex flex-col items-center justify-start p-6 md:p-12 max-w-3xl mx-auto w-full">
        <AnimatePresence mode="wait">
          <motion.div 
            key={currentQuestion.id}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="w-full space-y-8"
          >
            {/* Question Type & Timer Section (Matching Image) */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-primary/60 font-headline">Question Type</label>
                <div className="bg-surface-container-low p-4 rounded-2xl border border-outline-variant/10 text-on-surface font-headline font-bold">
                  {currentQuestion.type}
                </div>
              </div>
              
              <div className="space-y-2">
                <label className="text-[10px] font-bold uppercase tracking-widest text-primary/60 font-headline text-center block">Timer</label>
                <div className="bg-surface-container-low p-4 rounded-2xl border border-outline-variant/10 flex flex-col items-center justify-center relative overflow-hidden">
                  <div className="flex items-baseline gap-1 relative z-10">
                    <span className={cn(
                      "text-2xl font-headline font-extrabold transition-colors",
                      isQuestionTimeLow ? "text-error" : "text-on-surface"
                    )}>
                      {questionTimeLeft ?? currentQuestion.timer}
                    </span>
                    <span className="text-xs font-bold text-on-surface-variant">s</span>
                  </div>
                  <div className="w-full h-1 bg-surface-container-highest mt-2 rounded-full overflow-hidden relative z-10">
                    <motion.div 
                      initial={{ width: "100%" }}
                      animate={{ width: `${((questionTimeLeft ?? currentQuestion.timer) / currentQuestion.timer) * 100}%` }}
                      className={cn("h-full transition-colors", isQuestionTimeLow ? "bg-error" : "bg-primary")}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Question Text Section (Matching Image) */}
            <div className="space-y-2">
              <div className="flex justify-between items-end">
                <label className="text-[10px] font-bold uppercase tracking-widest text-primary/60 font-headline">Question</label>
                {isExpired && (
                  <span className="px-3 py-1 bg-error/10 text-error text-[10px] font-bold uppercase tracking-widest rounded-full flex items-center gap-1.5 animate-pulse">
                    <AlertCircle className="w-3 h-3" />
                    Time Expired
                  </span>
                )}
              </div>
              <div className={cn(
                "bg-surface-container-low p-8 rounded-3xl border border-outline-variant/10 min-h-[120px] flex flex-col items-center justify-center transition-opacity",
                isExpired && "opacity-60"
              )}>
                {currentQuestion.image && (
                  <div className="w-full mb-6">
                    <img src={currentQuestion.image} alt="Question" className="max-w-full h-auto rounded-2xl mx-auto shadow-sm border border-outline-variant/10" />
                  </div>
                )}
                <div className="w-full prose prose-invert max-w-none prose-sm md:prose-base text-on-surface text-center">
                  <ReactMarkdown 
                    remarkPlugins={[remarkMath]} 
                    rehypePlugins={[rehypeRaw, rehypeKatex]}
                  >
                    {currentQuestion.text || `Question ${currentQuestionIndex}`}
                  </ReactMarkdown>
                </div>
              </div>
            </div>

            {/* Options Section (Matching Image) */}
            <div className="space-y-4">
              {currentQuestion.type === "Paragraph" ? (
                <>
                  <div className={cn(
                    "group relative bg-surface-container-lowest rounded-2xl p-1 transition-all duration-300",
                    isExpired && "opacity-50 pointer-events-none"
                  )}>
                    <div className="absolute -inset-0.5 bg-gradient-to-br from-primary/10 to-transparent rounded-2xl blur-sm opacity-50 group-focus-within:opacity-100 transition-opacity"></div>
                    <div className="relative bg-surface-container-lowest rounded-[14px] overflow-hidden">
                      <textarea 
                        value={response}
                        onChange={handleResponseChange}
                        disabled={isExpired}
                        className="w-full h-64 p-8 bg-transparent border-none focus:ring-0 font-body text-lg leading-relaxed text-on-surface placeholder:text-outline-variant resize-none" 
                        placeholder={isExpired ? "Time has expired for this question." : "Type your explanation here..."} 
                      />
                      <div className="px-8 py-4 bg-surface-container-low/50 flex justify-between items-center border-t border-outline-variant/10">
                        <span className="text-xs font-label text-on-surface-variant flex items-center gap-2">
                          <Info className="w-4 h-4" />
                          Maximum 50 words
                        </span>
                        <span className={cn(
                          "text-xs font-label",
                          wordCount > 50 ? "text-error font-bold" : "text-on-surface-variant"
                        )}>{wordCount}/50 words</span>
                      </div>
                    </div>
                  </div>
                  {wordCount > 50 && !isExpired && (
                    <p className="text-error text-xs font-bold mt-2 px-2">Please reduce your answer to 50 words or less.</p>
                  )}
                </>
              ) : (
                <div className={cn("grid grid-cols-1 gap-3", isExpired && "opacity-60")}>
                  {(participant?.optionOrders?.[currentQuestion.id] || (currentQuestion.type === "True/False" ? ['A', 'B'] : ['A', 'B', 'C', 'D'])).filter(label => {
                    if (currentQuestion.type === "True/False") return label === 'A' || label === 'B';
                    return true;
                  }).map((label, idx) => {
                    const isSelected = Array.isArray(selectedOption) 
                      ? selectedOption.includes(label) 
                      : selectedOption === label;

                    return (
                      <button
                        key={label}
                        onClick={() => !isExpired && handleOptionSelect(label)}
                        disabled={isExpired}
                        className={cn(
                          "w-full p-4 rounded-2xl text-left font-headline font-bold text-lg transition-all border-2 flex items-center justify-between group",
                          isSelected 
                            ? "bg-emerald-50 border-emerald-500 text-emerald-900 shadow-sm" 
                            : "bg-surface-container-lowest border-outline-variant/10 text-on-surface hover:border-primary/30",
                          isExpired && "cursor-not-allowed"
                        )}
                      >
                        <div className="flex items-center gap-4">
                          <div className={cn(
                            "w-8 h-8 rounded-lg flex items-center justify-center text-xs transition-colors",
                            isSelected ? "bg-emerald-500 text-white" : "bg-surface-container-low text-on-surface-variant group-hover:bg-primary/10 group-hover:text-primary",
                            isExpired && "group-hover:bg-surface-container-low group-hover:text-on-surface-variant"
                          )}>
                            {String.fromCharCode(65 + idx)}
                          </div>
                          <span className="text-base">{currentQuestion.options[label] || `Option ${label}`}</span>
                        </div>
                        <div className={cn(
                          "w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all",
                          isSelected ? "bg-emerald-500 border-emerald-500" : "border-outline-variant/30"
                        )}>
                          {isSelected && <CheckCircle2 className="w-4 h-4 text-white" />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Navigation Actions */}
            <div className="pt-8 flex flex-col gap-4">
              <div className="bg-surface-container-low p-6 rounded-3xl border border-outline-variant/10 text-center space-y-2 shadow-sm">
                <p className="text-on-surface font-headline font-bold">
                  {isLastQuestion ? "Quiz will be submitted automatically" : "Next question will appear automatically"}
                </p>
                <p className="text-xs text-on-surface-variant font-medium">
                  {isLastQuestion ? "when the timer reaches zero." : "when the current timer ends."}
                </p>
              </div>

              <button 
                onClick={() => setShowLeaveWarning(true)}
                className="w-full py-3 text-on-surface-variant font-headline font-bold hover:text-error transition-colors text-sm"
              >
                Leave Quiz
              </button>
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Leave Warning Modal */}
        <AnimatePresence>
          {showLeaveWarning && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/50 backdrop-blur-sm">
              <motion.div 
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                className="bg-surface-container-lowest p-8 rounded-3xl shadow-2xl border border-surface-container max-w-md w-full"
              >
                <h3 className="font-headline text-2xl font-extrabold mb-4 text-on-surface">Leave Quiz?</h3>
                <p className="text-on-surface-variant mb-8">
                  If you leave now, your quiz will be submitted with your current progress. Any unanswered questions will be marked as skipped.
                </p>
                <div className="flex gap-4">
                  <button 
                    onClick={() => setShowLeaveWarning(false)}
                    className="flex-1 py-4 bg-surface-container-low text-on-surface font-headline font-bold rounded-xl hover:bg-surface-container transition-all"
                  >
                    Stay
                  </button>
                  <button 
                    onClick={handleLeaveQuiz}
                    className="flex-1 py-4 bg-error text-on-error font-headline font-bold rounded-xl shadow-lg shadow-error/20 hover:scale-[1.02] active:scale-95 transition-all"
                  >
                    Submit & Leave
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </main>

      {/* Decorative Kinetic Elements */}
      <div className="fixed bottom-0 left-0 -z-10 w-full h-1/2 overflow-hidden opacity-30 pointer-events-none">
        <svg className="w-full h-full" preserveAspectRatio="none" viewBox="0 0 1440 320">
          <path d="M0,160L48,176C96,192,192,224,288,213.3C384,203,480,149,576,149.3C672,149,768,203,864,213.3C960,224,1056,192,1152,176C1248,160,1344,160,1392,160L1440,160L1440,320L1392,320C1344,320,1248,320,1152,320C1056,320,960,320,864,320C768,320,672,320,576,320C480,320,384,320,288,320C192,320,96,320,48,320L0,320Z" fill="#809bff" fillOpacity="0.1"></path>
        </svg>
      </div>
    </div>
  );
}
