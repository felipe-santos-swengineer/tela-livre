"use client";

import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

type Mode = "home" | "host" | "watch";
type Signal =
  | { type: "offer" | "answer"; sdp: RTCSessionDescriptionInit }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const iceServers: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readSignal(value: unknown): Signal | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;

  if (
    (value.type === "offer" || value.type === "answer") &&
    isRecord(value.sdp) &&
    value.sdp.type === value.type &&
    typeof value.sdp.sdp === "string"
  ) {
    return {
      type: value.type,
      sdp: { type: value.type, sdp: value.sdp.sdp },
    };
  }

  if (
    value.type === "candidate" &&
    isRecord(value.candidate) &&
    typeof value.candidate.candidate === "string" &&
    (typeof value.candidate.sdpMid === "string" ||
      (typeof value.candidate.sdpMLineIndex === "number" &&
        Number.isInteger(value.candidate.sdpMLineIndex)))
  ) {
    const candidate: RTCIceCandidateInit = {
      candidate: value.candidate.candidate,
    };
    if (typeof value.candidate.sdpMid === "string") {
      candidate.sdpMid = value.candidate.sdpMid;
    }
    if (
      typeof value.candidate.sdpMLineIndex === "number" &&
      Number.isInteger(value.candidate.sdpMLineIndex)
    ) {
      candidate.sdpMLineIndex = value.candidate.sdpMLineIndex;
    }
    if (typeof value.candidate.usernameFragment === "string") {
      candidate.usernameFragment = value.candidate.usernameFragment;
    }

    return {
      type: "candidate",
      candidate,
    };
  }

  return null;
}

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) {
    throw new Error(
      "Configure NEXT_PUBLIC_SUPABASE_URL e NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY para iniciar uma transmissão.",
    );
  }

  return createClient(url, key);
}

export default function StreamApp() {
  const searchParams = useSearchParams();
  const initialRoom = searchParams.get("room") ?? undefined;
  const [mode, setMode] = useState<Mode>(initialRoom ? "watch" : "home");
  const [roomId, setRoomId] = useState(initialRoom ?? "");
  const [status, setStatus] = useState(
    initialRoom ? "Transmissão pronta para assistir" : "Pronto para começar",
  );
  const [error, setError] = useState("");
  const [viewerCount, setViewerCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [hasJoinedRoom, setHasJoinedRoom] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const pendingCandidatesRef = useRef(
    new Map<string, RTCIceCandidateInit[]>(),
  );
  const participantIdRef = useRef("");
  const modeRef = useRef<Mode>(initialRoom ? "watch" : "home");

  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = mode === "host" ? localStream : remoteStream;
    }
  }, [localStream, mode, remoteStream]);

  const send = useCallback(
    async (event: string, payload: Record<string, unknown>) => {
      const channel = channelRef.current;
      if (!channel) throw new Error("A conexão com a sala foi encerrada.");
      const result = await channel.send({
        type: "broadcast",
        event,
        payload,
      });
      if (result !== "ok") {
        throw new Error("Não foi possível enviar uma mensagem para a sala.");
      }
    },
    [],
  );

  const closePeer = useCallback((participantId: string) => {
    const peer = peersRef.current.get(participantId);
    if (peer) {
      peer.close();
      peersRef.current.delete(participantId);
      pendingCandidatesRef.current.delete(participantId);
    }
    setViewerCount(peersRef.current.size);
  }, []);

  const stopSession = useCallback(async () => {
    const channel = channelRef.current;
    const participantId = participantIdRef.current;

    if (channel && participantId) {
      try {
        await channel.send({
          type: "broadcast",
          event: modeRef.current === "host" ? "end" : "leave",
          payload: { sender: participantId },
        });
      } catch (sendError) {
        console.error("Não foi possível avisar a sala ao sair:", sendError);
      }
    }

    peersRef.current.forEach((peer) => peer.close());
    peersRef.current.clear();
    pendingCandidatesRef.current.clear();
    setViewerCount(0);
    channelRef.current = null;
    if (channel) await channel.unsubscribe();

    if (modeRef.current === "host") {
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
    }
    localStreamRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setHasJoinedRoom(false);
    participantIdRef.current = "";
    modeRef.current = "home";
    window.history.replaceState(null, "", `${basePath}/`);
    setMode("home");
    setStatus("Transmissão encerrada");
  }, []);

  useEffect(() => {
    const peers = peersRef.current;
    return () => {
      peers.forEach((peer) => peer.close());
      channelRef.current?.unsubscribe();
      localStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const startHosting = async () => {
    setError("");
    setStatus("Solicitando compartilhamento de tela…");
    let capturedStream: MediaStream | null = null;

    try {
      const supabase = getSupabase();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30 } },
        audio: false,
      });
      capturedStream = stream;
      localStreamRef.current = stream;
      const newRoomId = crypto.randomUUID();
      const participantId = "host";
      const channel = supabase.channel(`room:${newRoomId}`, {
        config: { broadcast: { self: false } },
      });

      setRoomId(newRoomId);
      setLocalStream(stream);
      setMode("host");
      modeRef.current = "host";
      participantIdRef.current = participantId;
      channelRef.current = channel;
      window.history.replaceState(
        null,
        "",
        `${basePath}/?room=${newRoomId}`,
      );

      const createPeer = async (viewerId: string) => {
        if (peersRef.current.has(viewerId)) return;

        const peer = new RTCPeerConnection({ iceServers });
        peersRef.current.set(viewerId, peer);
        setViewerCount(peersRef.current.size);
        stream.getTracks().forEach((track) => peer.addTrack(track, stream));
        peer.onicecandidate = (event) => {
          if (event.candidate) {
            void send("signal", {
              sender: participantId,
              target: viewerId,
              signal: {
                type: "candidate",
                candidate: event.candidate.toJSON(),
              },
            }).catch(setError);
          }
        };
        peer.onconnectionstatechange = () => {
          if (peer.connectionState === "failed" || peer.connectionState === "closed") {
            closePeer(viewerId);
          }
        };

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        await send("signal", {
          sender: participantId,
          target: viewerId,
          signal: { type: "offer", sdp: peer.localDescription },
        });
      };

      channel
        .on("broadcast", { event: "join" }, ({ payload }) => {
          if (
            isRecord(payload) &&
            typeof payload.sender === "string" &&
            payload.sender !== participantId
          ) {
            void createPeer(payload.sender).catch((peerError: unknown) => {
              setError(
                peerError instanceof Error
                  ? peerError.message
                  : "Não foi possível conectar um espectador.",
              );
            });
          }
        })
        .on("broadcast", { event: "leave" }, ({ payload }) => {
          if (isRecord(payload) && typeof payload.sender === "string") {
            closePeer(payload.sender);
          }
        })
        .on("broadcast", { event: "signal" }, async ({ payload }) => {
          try {
            if (
              !isRecord(payload) ||
              payload.target !== participantId ||
              typeof payload.sender !== "string"
            ) {
              return;
            }

            const signal = readSignal(payload.signal);
            const peer = peersRef.current.get(payload.sender);
            if (!signal || !peer) return;

            if (signal.type === "answer") {
              await peer.setRemoteDescription(signal.sdp);
              const candidates =
                pendingCandidatesRef.current.get(payload.sender) ?? [];
              for (const candidate of candidates) {
                await peer.addIceCandidate(candidate);
              }
              pendingCandidatesRef.current.delete(payload.sender);
            } else if (signal.type === "candidate") {
              if (peer.remoteDescription) {
                await peer.addIceCandidate(signal.candidate);
              } else {
                const candidates =
                  pendingCandidatesRef.current.get(payload.sender) ?? [];
                candidates.push(signal.candidate);
                pendingCandidatesRef.current.set(payload.sender, candidates);
              }
            }
          } catch (signalError) {
            setError(
              signalError instanceof Error
                ? signalError.message
                : "Falha ao negociar a conexão com um espectador.",
            );
          }
        })
        .subscribe((channelStatus) => {
          if (channelStatus === "SUBSCRIBED") {
            setStatus("Você está ao vivo");
          } else if (channelStatus === "CHANNEL_ERROR") {
            setError("Não foi possível conectar à sala. Confira a configuração do Supabase.");
          }
        });

      stream.getVideoTracks()[0].addEventListener(
        "ended",
        () => void stopSession(),
        { once: true },
      );
    } catch (startError) {
      capturedStream?.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
      channelRef.current?.unsubscribe();
      channelRef.current = null;
      peersRef.current.forEach((peer) => peer.close());
      peersRef.current.clear();
      participantIdRef.current = "";
      modeRef.current = "home";
      window.history.replaceState(null, "", "/");
      setRoomId("");
      setLocalStream(null);
      setMode("home");
      setStatus("Pronto para começar");
      setError(
        startError instanceof Error
          ? startError.message
          : "Não foi possível iniciar o compartilhamento de tela.",
      );
    }
  };

  const joinStream = async () => {
    if (!roomId || participantIdRef.current) return;
    setError("");
    setStatus("Conectando à transmissão…");

    try {
      const supabase = getSupabase();
      const participantId = crypto.randomUUID();
      const channel = supabase.channel(`room:${roomId}`, {
        config: { broadcast: { self: false } },
      });
      const peer = new RTCPeerConnection({ iceServers });
      peersRef.current.set("host", peer);
      participantIdRef.current = participantId;
      channelRef.current = channel;
      setMode("watch");
      modeRef.current = "watch";
      setHasJoinedRoom(true);

      peer.ontrack = (event) => {
        setRemoteStream(event.streams[0] ?? new MediaStream([event.track]));
        setStatus("Assistindo à transmissão");
      };
      peer.onicecandidate = (event) => {
        if (event.candidate) {
          void send("signal", {
            sender: participantId,
            target: "host",
            signal: {
              type: "candidate",
              candidate: event.candidate.toJSON(),
            },
          }).catch(setError);
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed") {
          setError(
            "Não foi possível estabelecer a conexão direta. A rede pode exigir um servidor TURN.",
          );
        } else if (peer.connectionState === "connected") {
          setStatus("Assistindo à transmissão");
        }
      };

      channel
        .on("broadcast", { event: "signal" }, async ({ payload }) => {
          try {
            if (
              !isRecord(payload) ||
              payload.target !== participantId ||
              payload.sender !== "host"
            ) {
              return;
            }
            const signal = readSignal(payload.signal);
            if (!signal) return;

            if (signal.type === "offer") {
              await peer.setRemoteDescription(signal.sdp);
              const answer = await peer.createAnswer();
              await peer.setLocalDescription(answer);
              await send("signal", {
                sender: participantId,
                target: "host",
                signal: { type: "answer", sdp: peer.localDescription },
              });
              const candidates = pendingCandidatesRef.current.get("host") ?? [];
              for (const candidate of candidates) {
                await peer.addIceCandidate(candidate);
              }
              pendingCandidatesRef.current.delete("host");
            } else if (signal.type === "candidate") {
              if (peer.remoteDescription) {
                await peer.addIceCandidate(signal.candidate);
              } else {
                const candidates =
                  pendingCandidatesRef.current.get("host") ?? [];
                candidates.push(signal.candidate);
                pendingCandidatesRef.current.set("host", candidates);
              }
            }
          } catch (signalError) {
            setError(
              signalError instanceof Error
                ? signalError.message
                : "Falha ao conectar à transmissão.",
            );
          }
        })
        .on("broadcast", { event: "end" }, ({ payload }) => {
          if (isRecord(payload) && payload.sender === "host") {
            void stopSession().then(() =>
              setStatus("A transmissão foi encerrada"),
            );
          }
        })
        .subscribe((channelStatus) => {
          if (channelStatus === "SUBSCRIBED") {
            setStatus("Entrando na sala…");
            void send("join", { sender: participantId }).catch(setError);
          } else if (channelStatus === "CHANNEL_ERROR") {
            setError("Não foi possível encontrar a sala. Ela pode ter sido encerrada.");
          }
        });
    } catch (joinError) {
      peersRef.current.forEach((peer) => peer.close());
      peersRef.current.clear();
      channelRef.current?.unsubscribe();
      channelRef.current = null;
      participantIdRef.current = "";
      setHasJoinedRoom(false);
      setStatus("Transmissão pronta para assistir");
      setError(
        joinError instanceof Error
          ? joinError.message
          : "Não foi possível entrar na transmissão.",
      );
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (copyError) {
      setError(
        copyError instanceof Error
          ? "Não foi possível copiar o link. Copie-o direto da barra do navegador."
          : "Falha ao copiar o link.",
      );
    }
  };

  const isHost = mode === "host";
  const isWatching = mode === "watch";

  return (
    <main className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="TelaLivre início">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span>telalivre</span>
        </Link>
        <span className="topbar-note">
          <span className="online-dot" />
          Compartilhamento direto
        </span>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="eyebrow-line" />
            SUA TELA, AO VIVO
          </div>
          <h1>
            Mostre o que
            <br />
            está na sua <span>tela.</span>
          </h1>
          <p className="hero-description">
            Comece uma transmissão e compartilhe o link. Sem downloads para
            quem vai assistir.
          </p>
          {!isHost && !isWatching && (
            <button
              className="primary-button"
              onClick={startHosting}
              disabled={status === "Solicitando compartilhamento de tela…"}
            >
              <span className="button-icon" aria-hidden="true">
                ↗
              </span>
              Compartilhar minha tela
            </button>
          )}
          {isWatching && !remoteStream && (
            <button
              className="primary-button"
              onClick={joinStream}
              disabled={
                status === "Conectando à transmissão…" ||
                status === "Entrando na sala…"
              }
            >
              <span className="button-icon" aria-hidden="true">
                ▶
              </span>
              Entrar na transmissão
            </button>
          )}
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <div className="trust-note">
            <span aria-hidden="true">✳</span>
            Você controla quando começa e quando termina.
          </div>
        </div>

        <div className={`screen-card${isHost ? " is-live" : ""}`}>
          <div className="screen-toolbar">
            <div className="window-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <span className="screen-title">
              {isHost ? "Sua transmissão" : "Prévia da transmissão"}
            </span>
            {(isHost || remoteStream) && (
              <span className="live-badge">
                <span />
                AO VIVO
              </span>
            )}
          </div>
          <div className="video-stage">
            {(isHost || remoteStream) && (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted={isHost}
                className="shared-video"
              />
            )}
            {!isHost && !remoteStream && (
              <div className="empty-preview">
                <div className="preview-icon" aria-hidden="true">
                  <svg viewBox="0 0 48 48" fill="none">
                    <rect
                      x="5"
                      y="9"
                      width="28"
                      height="25"
                      rx="3"
                      stroke="currentColor"
                      strokeWidth="1.7"
                    />
                    <path
                      d="m33 18 10-5v17l-10-5"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M13 40h12M19 34v6"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      strokeLinecap="round"
                    />
                  </svg>
                </div>
                <strong>
                  {isWatching
                    ? "A transmissão ainda não começou"
                    : "Sua tela aparece aqui"}
                </strong>
                <span>
                  {isWatching
                    ? "Entre na sala quando o transmissor estiver ao vivo."
                    : "Clique em “Compartilhar minha tela” para começar."}
                </span>
              </div>
            )}
          </div>
          <div className="screen-footer">
            <span className="status-label">
              <span className={isHost || remoteStream ? "status-pulse" : "status-idle"} />
              {status}
            </span>
            {isHost && (
              <span className="viewer-count">
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M13.3 16.2v-1.5a3 3 0 0 0-3-3H5.8a3 3 0 0 0-3 3v1.5m12.4-4.5a3 3 0 0 1 2.4 3v1.5M8 8.8a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm5.5-6.1a3.2 3.2 0 0 1 0 6.1"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                {viewerCount} assistindo
              </span>
            )}
          </div>
          {isHost && (
            <div className="share-row">
              <div className="share-link">
                <span className="share-link-icon" aria-hidden="true">
                  ↗
                </span>
                <span className="share-url">
                  {typeof window !== "undefined"
                    ? `${window.location.host}${basePath}/?room=${roomId}`
                    : ""}
                </span>
              </div>
              <button className="copy-button" onClick={copyLink}>
                {copied ? "Copiado!" : "Copiar link"}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className="how-it-works" aria-label="Como funciona">
        <div className="section-heading">
          <span>SEM COMPLICAÇÃO</span>
          <h2>Da sua tela para o mundo.</h2>
        </div>
        <div className="steps">
          <article className="step-card">
            <span className="step-number">01</span>
            <div className="step-icon" aria-hidden="true">
              <svg viewBox="0 0 32 32" fill="none">
                <rect
                  x="4"
                  y="5"
                  width="24"
                  height="18"
                  rx="2.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M11 28h10m-5-5v5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <h3>Escolha sua tela</h3>
            <p>Selecione uma janela, aba ou a tela inteira.</p>
          </article>
          <article className="step-card">
            <span className="step-number">02</span>
            <div className="step-icon" aria-hidden="true">
              <svg viewBox="0 0 32 32" fill="none">
                <path
                  d="M12 17.5a5 5 0 0 0 7.1 0l3.5-3.5a5 5 0 0 0-7.1-7.1l-2 2m4.5 5.1a5 5 0 0 0-7.1 0l-3.5 3.5a5 5 0 0 0 7.1 7.1l2-2"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <h3>Compartilhe o link</h3>
            <p>Envie o link para as pessoas que vão assistir.</p>
          </article>
          <article className="step-card">
            <span className="step-number">03</span>
            <div className="step-icon" aria-hidden="true">
              <svg viewBox="0 0 32 32" fill="none">
                <path
                  d="M16 6.5a9.5 9.5 0 1 0 9.5 9.5M16 3v5m13 8h-5m-8 8v5m-8-13H3m13-7v8l5 3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <h3>Transmitindo!</h3>
            <p>Quem tiver o link assiste direto no navegador.</p>
          </article>
        </div>
      </section>

      {isHost && (
        <div className="end-session">
          <button className="end-button" onClick={() => void stopSession()}>
            Encerrar transmissão
          </button>
        </div>
      )}
      {isWatching && hasJoinedRoom && (
        <div className="end-session">
          <button className="end-button" onClick={() => void stopSession()}>
            Sair da transmissão
          </button>
        </div>
      )}

      <footer className="footer">
        <Link className="brand footer-brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span>telalivre</span>
        </Link>
        <span>Feito para compartilhar ideias, não complicações.</span>
      </footer>
    </main>
  );
}
