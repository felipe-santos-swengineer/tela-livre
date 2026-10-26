"use client";

import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

type Mode = "home" | "host" | "watch";
type Resolution = "720p" | "1080p";
type FrameRate = 15 | 30 | 60;
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

function isHostPresence(value: unknown): boolean {
  return isRecord(value) && value.role === "host";
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
  const [resolution, setResolution] = useState<Resolution>("720p");
  const [frameRate, setFrameRate] = useState<FrameRate>(30);
  const [includeAudio, setIncludeAudio] = useState(true);
  const [error, setError] = useState("");
  const [viewerCount, setViewerCount] = useState(0);
  const [copied, setCopied] = useState(false);
  const [hasJoinedRoom, setHasJoinedRoom] = useState(false);
  const [hostEnded, setHostEnded] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoStageRef = useRef<HTMLDivElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<RealtimeChannel | null>(null);
  const peersRef = useRef(new Map<string, RTCPeerConnection>());
  const pendingCandidatesRef = useRef(
    new Map<string, RTCIceCandidateInit[]>(),
  );
  const participantIdRef = useRef("");
  const modeRef = useRef<Mode>(initialRoom ? "watch" : "home");
  const hostSeenRef = useRef(false);
  const hostEndedRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const updateFullscreen = () => {
      setIsFullscreen(
        document.fullscreenElement === videoStageRef.current,
      );
    };
    document.addEventListener("fullscreenchange", updateFullscreen);
    return () =>
      document.removeEventListener("fullscreenchange", updateFullscreen);
  }, []);

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

  const stopSession = useCallback(
    async (options?: { returnHome?: boolean; status?: string }) => {
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
    if (options?.returnHome !== false) {
      hostSeenRef.current = false;
      hostEndedRef.current = false;
      setHostEnded(false);
      modeRef.current = "home";
      window.history.replaceState(null, "", `${basePath}/`);
      setRoomId("");
      setMode("home");
    } else {
      setHostEnded(true);
    }
    setStatus(options?.status ?? "Transmissão encerrada");
    },
    [],
  );

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
    const captureWidth = resolution === "720p" ? 1280 : 1920;
    const captureHeight = resolution === "720p" ? 720 : 1080;

    try {
      const supabase = getSupabase();
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: captureWidth, max: captureWidth },
          height: { ideal: captureHeight, max: captureHeight },
          frameRate: { ideal: frameRate, max: frameRate },
        },
        audio: includeAudio,
      });
      capturedStream = stream;
      const screenTrack = stream.getVideoTracks()[0];
      if (screenTrack) {
        screenTrack.contentHint = frameRate >= 30 ? "motion" : "detail";
      }
      localStreamRef.current = stream;
      const newRoomId = crypto.randomUUID();
      const participantId = "host";
      const channel = supabase.channel(`room:${newRoomId}`, {
        config: {
          broadcast: { self: false },
          presence: { key: participantId },
        },
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
        for (const track of stream.getTracks()) {
          const sender = peer.addTrack(track, stream);
          if (track.kind === "video") {
            const parameters = sender.getParameters();
            parameters.encodings = [
              {
                ...parameters.encodings?.[0],
                maxBitrate:
                  resolution === "1080p"
                    ? frameRate === 60
                      ? 4_500_000
                      : 3_000_000
                    : frameRate === 60
                      ? 3_000_000
                      : 2_000_000,
                maxFramerate: frameRate,
              },
            ];
            parameters.degradationPreference = "maintain-framerate";
            try {
              await sender.setParameters(parameters);
            } catch (encodingError) {
              console.warn(
                "O navegador não aplicou o perfil de transmissão otimizado:",
                encodingError,
              );
            }
          }
        }
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
            void channel
              .track({ role: "host" })
              .then((trackStatus) => {
                if (trackStatus !== "ok") {
                  throw new Error("Não foi possível anunciar a transmissão na sala.");
                }
                setStatus("Você está ao vivo");
              })
              .catch((presenceError: unknown) => {
                setError(
                  presenceError instanceof Error
                    ? presenceError.message
                    : "Não foi possível anunciar a transmissão na sala.",
                );
              });
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
    if (!roomId || participantIdRef.current || hostEndedRef.current) return;
    setError("");
    setStatus("Conectando à transmissão…");

    try {
      const supabase = getSupabase();
      const participantId = crypto.randomUUID();
      const channel = supabase.channel(`room:${roomId}`, {
        config: {
          broadcast: { self: false },
          presence: { key: participantId },
        },
      });
      const peer = new RTCPeerConnection({ iceServers });
      peersRef.current.set("host", peer);
      participantIdRef.current = participantId;
      channelRef.current = channel;
      setMode("watch");
      modeRef.current = "watch";
      setHasJoinedRoom(true);
      setHostEnded(false);
      hostSeenRef.current = false;
      hostEndedRef.current = false;

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
        .on("presence", { event: "sync" }, () => {
          const presenceState = channel.presenceState();
          const hostIsPresent = (presenceState.host ?? []).some(isHostPresence);
          if (hostIsPresent) {
            hostSeenRef.current = true;
          } else if (hostSeenRef.current && !hostEndedRef.current) {
            hostEndedRef.current = true;
            void stopSession({
              returnHome: false,
              status: "O anfitrião encerrou a transmissão.",
            }).then(() => setHostEnded(true));
          }
        })
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
          if (isRecord(payload) && payload.sender === "host" && !hostEndedRef.current) {
            hostEndedRef.current = true;
            void stopSession({
              returnHome: false,
              status: "O anfitrião encerrou a transmissão.",
            }).then(() => setHostEnded(true));
          }
        })
        .subscribe((channelStatus) => {
          if (channelStatus === "SUBSCRIBED") {
            void channel
              .track({ role: "viewer" })
              .then(async (trackStatus) => {
                if (trackStatus !== "ok") {
                  throw new Error("Não foi possível entrar na lista de espectadores.");
                }
                setStatus("Entrando na sala…");
                await send("join", { sender: participantId });
              })
              .catch((presenceError: unknown) => {
                setError(
                  presenceError instanceof Error
                    ? presenceError.message
                    : "Não foi possível entrar na transmissão.",
                );
              });
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
      hostSeenRef.current = false;
      hostEndedRef.current = false;
      setHostEnded(false);
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

  const toggleFullscreen = async () => {
    const videoStage = videoStageRef.current;
    if (!videoStage) return;

    try {
      if (document.fullscreenElement === videoStage) {
        await document.exitFullscreen();
      } else {
        await videoStage.requestFullscreen();
      }
    } catch (fullscreenError) {
      setError(
        fullscreenError instanceof Error
          ? "Não foi possível expandir a transmissão. Verifique se o navegador permite tela cheia."
          : "Falha ao expandir a transmissão.",
      );
    }
  };

  const isHost = mode === "host";
  const isWatching = mode === "watch";

  return (
    <main className="app-shell">
      <header className="topbar">
        <Link className="brand" href="/" aria-label="Tela Livre início">
          <span className="brand-mark" aria-hidden="true">
            <span />
          </span>
          <span>tela livre</span>
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
            <div className="transmission-settings">
              <span className="settings-title">Configurações da transmissão</span>
              <div className="settings-selects">
                <label className="setting-field">
                  <span>Resolução</span>
                  <select
                    value={resolution}
                    onChange={(event) => {
                      if (
                        event.target.value === "720p" ||
                        event.target.value === "1080p"
                      ) {
                        setResolution(event.target.value);
                      }
                    }}
                  >
                    <option value="720p">720p — menor uso de rede</option>
                    <option value="1080p">1080p — mais definição</option>
                  </select>
                </label>
                <label className="setting-field">
                  <span>Quadros por segundo</span>
                  <select
                    value={frameRate}
                    onChange={(event) => {
                      const selectedRate = Number(event.target.value);
                      if (
                        selectedRate === 15 ||
                        selectedRate === 30 ||
                        selectedRate === 60
                      ) {
                        setFrameRate(selectedRate);
                      }
                    }}
                  >
                    <option value={15}>15 FPS — menor carga</option>
                    <option value={30}>30 FPS — recomendado</option>
                    <option value={60}>60 FPS — mais fluido</option>
                  </select>
                </label>
              </div>
              <label className="audio-toggle">
                <input
                  type="checkbox"
                  checked={includeAudio}
                  onChange={(event) => setIncludeAudio(event.target.checked)}
                />
                <span className="audio-toggle-track" aria-hidden="true">
                  <span />
                </span>
                <span className="audio-toggle-copy">
                  <strong>Áudio da tela</strong>
                  <span>Não inclui o microfone</span>
                </span>
              </label>
              <p className="settings-hint">
                720p e 30 FPS são recomendados para reduzir travamentos. A
                disponibilidade de áudio depende do navegador e da aba escolhida.
              </p>
            </div>
          )}
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
          {isHost && (
            <button
              className="primary-button stop-stream-button"
              onClick={() => void stopSession()}
            >
              <span className="button-icon" aria-hidden="true">
                ■
              </span>
              Encerrar transmissão
            </button>
          )}
          {isWatching && !remoteStream && !hostEnded && (
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
          {hostEnded && (
            <div className="ended-notice" role="status">
              <p>O anfitrião encerrou a transmissão.</p>
              <button
                className="ended-home-button"
                onClick={() => void stopSession()}
              >
                Voltar ao início
              </button>
            </div>
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
            <button
              className="fullscreen-button"
              type="button"
              onClick={toggleFullscreen}
              disabled={!isHost && !remoteStream}
              aria-label={
                isFullscreen ? "Sair da tela cheia" : "Expandir transmissão"
              }
              title={isFullscreen ? "Sair da tela cheia" : "Expandir transmissão"}
            >
              {isFullscreen ? (
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M7.25 3.5v3.75H3.5m13 0h-3.75V3.5m0 13v-3.75h3.75m-13 0h3.75v3.75"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M3.5 7.25V3.5h3.75m5.5 0h3.75v3.75m0 5.5v3.75h-3.75m-5.5 0H3.5v-3.75"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          </div>
          <div ref={videoStageRef} className="video-stage">
            {(isHost || remoteStream) && (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted={isHost}
                controls={isWatching && Boolean(remoteStream)}
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
                  {hostEnded
                    ? "Transmissão encerrada"
                    : isWatching
                    ? "A transmissão ainda não começou"
                    : "Sua tela aparece aqui"}
                </strong>
                <span>
                  {hostEnded
                    ? "O anfitrião encerrou a live; você foi desconectado."
                    : isWatching
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
            {(isHost || remoteStream) && (
              <span className="audio-status">
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <path
                    d="M3 8v4h3l4 3V5L6 8H3Zm10-1a4 4 0 0 1 0 6m2-8a7 7 0 0 1 0 10"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {isHost
                  ? localStream?.getAudioTracks().length
                    ? "Áudio da tela incluído"
                    : "Sem áudio da tela"
                  : remoteStream?.getAudioTracks().length
                    ? "Áudio disponível"
                    : "Sem áudio"}
              </span>
            )}
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
          <span>tela livre</span>
        </Link>
        <span>Feito para compartilhar ideias, não complicações.</span>
      </footer>
    </main>
  );
}
