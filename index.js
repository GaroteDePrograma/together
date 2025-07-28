// Módulo de conexão P2P via PeerJS (integração em runtime)
async function loadPeerJS() {
    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://unpkg.com/peerjs@1.4.7/dist/peerjs.min.js";
        script.onload = () => resolve(window.Peer);
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// Grab any variables you need
const react = Spicetify.React;
const reactDOM = Spicetify.ReactDOM;
const {
    URI,
    React: { useState, useEffect, useCallback },
    Platform: { History },
    Player,
    CosmosAsync,
    LibURI
} = Spicetify;

// The main custom app render function. The component returned is what is rendered in Spotify.
function render() {
    setupGlobalListeners(); // Garante que os listeners globais estão ativos
    return react.createElement(TogetherApp, { title: "Together" });
}

// Variáveis estáticas para manter o estado entre montagens do componente
let globalPeer = null;
let globalConnections = [];
let globalIsHost = false;
let globalIsPaired = false;
let globalRemotePeerId = "";
let globalRoomMembers = [];

// Variáveis globais para manter listeners ativos mesmo após desmontagem
let globalTrackInterval = null;
let globalPlayerStateInterval = null;

// Variáveis para controle de sincronização e evitar loops
let lastSyncTime = 0;
let isSyncing = false;
let pendingSync = null;
let lastControlUser = null; // Armazena o ID do último usuário que controlou a música
let currentUserPriority = false; // Indica se o usuário atual tem prioridade
let isHandlingRemotePlayPause = false; // Evita loop de play/pause
let isHandlingRemoteSeek = false; // Evita loop de seek
let isHandlingRemoteSkip = false; // Evita loop de navegação

// --- NOVO: Gerenciador Global de Sincronização ---
const globalPlayerManager = {
    component: null, // Referência ao componente React montado
    currentTrack: null,
    currentPosition: 0,
    isPlaying: false,

    register(component) {
        this.component = component;
        // Sincroniza o estado do componente com o estado global ao registrar
        this.component.setState({
            currentTrack: this.currentTrack,
            currentPosition: this.currentPosition,
            isPlaying: this.isPlaying,
        });
    },

    unregister() {
        this.component = null;
    },

    // Atualiza o estado global e o do componente (se estiver montado)
    updateState(newState) {
        Object.assign(this, newState);
        if (this.component) {
            this.component.setState(newState);
        }
    },

    showNotification(message, type) {
        if (this.component) {
            this.component.showNotification(message, type);
        } else {
            // Fallback se o componente não estiver visível
            Spicetify.showNotification(message);
        }
    },

    broadcast(message) {
        if (globalIsPaired) {
            globalConnections.forEach(conn => {
                if (conn.open) {
                    conn.send(message);
                }
            });
        }
    },

    // --- Funções de Navegação de Música ---
    skipToNext: () => {
        if (globalPlayerManager.component) {
            globalPlayerManager.component.skipToNext();
        } else {
            // Fallback direto se o componente não estiver visível
            Spicetify.Player.next();
        }
    },

    skipToPrevious: () => {
        if (globalPlayerManager.component) {
            globalPlayerManager.component.skipToPrevious();
        } else {
            // Fallback direto se o componente não estiver visível
            Spicetify.Player.back();
        }
    },

    // --- Handlers de Eventos Globais ---
    handleSongChange: () => {
        const currentTrack = Spicetify.Player.data?.item;
        const currentPosition = Spicetify.Player.getProgress();
        const wasNearEnd = globalPlayerManager.currentTrack && 
                          globalPlayerManager.currentPosition > (globalPlayerManager.currentTrack.duration - 5000);
        
        // Detecta navegação manual vs mudança automática
        const isManualSkip = !wasNearEnd && 
                           currentPosition < 5000 && 
                           !isHandlingRemoteSkip && 
                           !isSyncing &&
                           currentTrack &&
                           globalPlayerManager.currentTrack &&
                           currentTrack.uri !== globalPlayerManager.currentTrack.uri;
        
        if (isManualSkip && globalIsPaired) {
            // Usuário navegou manualmente - sincronizar com outros
            console.log("Together: Navegação manual detectada");
            
            const trackInfo = {
                name: currentTrack.name || "Música Desconhecida",
                artist: currentTrack.artists?.[0]?.name || "Artista Desconhecido",
                album: currentTrack.album?.name || "Álbum Desconhecido",
                duration: currentTrack.duration_ms || currentTrack.duration || 0,
                uri: currentTrack.uri,
                image: currentTrack.album?.images?.[0]?.url || null,
            };

            globalPlayerManager.broadcast({
                type: "track_change",
                data: trackInfo,
                position: currentPosition,
                isPlaying: Spicetify.Player.isPlaying(),
                timestamp: Date.now(),
                controlUser: globalPeer?.id
            });
            
            lastControlUser = globalPeer?.id;
            currentUserPriority = true;
            globalPlayerManager.showNotification("Música sincronizada com outros usuários", "info");
        }
        
        if (wasNearEnd && globalIsPaired) {
            if (currentUserPriority) {
                globalPlayerManager.updateCurrentTrack(true);
            } else {
                setTimeout(() => {
                    const currentUri = Spicetify.Player.data?.item?.uri;
                    const stateUri = globalPlayerManager.currentTrack?.uri;
                    if (currentUri && currentUri !== stateUri && !isSyncing) {
                        globalPlayerManager.updateCurrentTrack(true);
                    }
                }, 3000);
            }
        } else {
            globalPlayerManager.updateCurrentTrack(true);
        }
    },

    handlePlayPause: () => {
        if (isHandlingRemotePlayPause) return;
        
        const isPlaying = Spicetify.Player.isPlaying();
        globalPlayerManager.updateState({ isPlaying });
        
        if (globalIsPaired) {
            globalPlayerManager.broadcast({
                type: "play_pause",
                data: { 
                    isPlaying,
                    timestamp: Date.now(),
                    position: Spicetify.Player.getProgress()
                }
            });
        }
    },

    handleProgress: () => {
        const position = Spicetify.Player.getProgress();
        const positionDiff = Math.abs(position - globalPlayerManager.currentPosition);
        
        if (positionDiff > 3000 && !isHandlingRemoteSeek && !isSyncing && globalIsPaired) {
            setTimeout(() => {
                const currentPos = Spicetify.Player.getProgress();
                const finalDiff = Math.abs(currentPos - globalPlayerManager.currentPosition);
                
                if (finalDiff > 2000 && !isHandlingRemoteSeek) {
                    globalPlayerManager.broadcast({
                        type: "seek",
                        data: { position: currentPos, timestamp: Date.now() }
                    });
                    globalPlayerManager.showNotification("Posição sincronizada para todos", "info");
                    globalPlayerManager.updateState({ currentPosition: currentPos });
                }
            }, 200);
        } else {
            globalPlayerManager.updateState({ currentPosition: position });
        }
    },

    updateCurrentTrack: (forceSync = false) => {
        const playerData = Spicetify.Player.data;
        if (!playerData || !playerData.item) return;
        
        const currentTrack = playerData.item;
        const trackInfo = {
            name: currentTrack.name || "Música Desconhecida",
            artist: currentTrack.artists?.[0]?.name || "Artista Desconhecido",
            album: currentTrack.album?.name || "Álbum Desconhecido",
            duration: currentTrack.duration_ms || currentTrack.duration || 0,
            uri: currentTrack.uri,
            image: currentTrack.album?.images?.[0]?.url || null,
        };
        
        const trackChanged = !globalPlayerManager.currentTrack || globalPlayerManager.currentTrack.uri !== trackInfo.uri;
        
        if (trackChanged || forceSync) {
            globalPlayerManager.updateState({ currentTrack: trackInfo });
            
            if (globalIsPaired && !isSyncing) {
                const now = Date.now();
                if (now - lastSyncTime < 500) return;
                lastSyncTime = now;
                
                const currentPosition = Spicetify.Player.getProgress();
                const isPlaying = Spicetify.Player.isPlaying();
                
                globalPlayerManager.broadcast({
                    type: "track_change",
                    data: trackInfo,
                    position: currentPosition,
                    isPlaying: isPlaying,
                    timestamp: now,
                    controlUser: globalPeer?.id
                });
                
                lastControlUser = globalPeer?.id;
                currentUserPriority = true;
                
                if (trackChanged) {
                    globalPlayerManager.showNotification(`Alterou para: ${trackInfo.name} - ${trackInfo.artist}`, "info");
                }
            }
        } else if (JSON.stringify(trackInfo) !== JSON.stringify(globalPlayerManager.currentTrack)) {
            globalPlayerManager.updateState({ currentTrack: trackInfo });
        }
    },

    updatePlayerState: () => {
        const isPlaying = Spicetify.Player.isPlaying();
        const currentPosition = Spicetify.Player.getProgress();
        
        if (isPlaying !== globalPlayerManager.isPlaying || Math.abs(currentPosition - globalPlayerManager.currentPosition) > 1000) {
            globalPlayerManager.updateState({ isPlaying, currentPosition });
        }
    }
};

// --- FIM DO GERENCIADOR GLOBAL ---

// Função para configurar os listeners globais uma única vez
let listenersAttached = false;
function setupGlobalListeners() {
    if (listenersAttached) return;

    Spicetify.Player.addEventListener("songchange", globalPlayerManager.handleSongChange);
    Spicetify.Player.addEventListener("onplaypause", globalPlayerManager.handlePlayPause);
    Spicetify.Player.addEventListener("onprogress", globalPlayerManager.handleProgress);

    // Adiciona listeners para os botões nativos do Spotify
    setupNativeControlsListeners();
    
    // Adiciona listener para atalhos de teclado
    setupKeyboardListeners();

    if (!globalTrackInterval) {
        globalTrackInterval = setInterval(globalPlayerManager.updateCurrentTrack, 3000);
    }
    if (!globalPlayerStateInterval) {
        globalPlayerStateInterval = setInterval(globalPlayerManager.updatePlayerState, 1000);
    }

    listenersAttached = true;
    console.log("Together: Listeners de sincronização global ativados.");
}

// Função para configurar listeners dos controles nativos do Spotify
function setupNativeControlsListeners() {
    // Listener para capturar cliques nos botões nativos
    const addNativeButtonListeners = () => {
        // Múltiplos seletores para diferentes versões do Spotify
        const nextButtonSelectors = [
            '[data-testid="control-button-skip-forward"]',
            '[aria-label*="next" i]',
            '[aria-label*="próxima" i]',
            '[aria-label*="avançar" i]',
            '.control-button[aria-label*="Next"]',
            'button[class*="skip"][class*="forward"]',
            'button[title*="Next"]'
        ];

        const prevButtonSelectors = [
            '[data-testid="control-button-skip-back"]',
            '[aria-label*="previous" i]',
            '[aria-label*="anterior" i]',
            '[aria-label*="voltar" i]',
            '.control-button[aria-label*="Previous"]',
            'button[class*="skip"][class*="back"]',
            'button[title*="Previous"]'
        ];

        // Tenta encontrar o botão de próxima música
        let nextButton = null;
        for (const selector of nextButtonSelectors) {
            nextButton = document.querySelector(selector);
            if (nextButton) break;
        }

        if (nextButton && !nextButton.hasTogetherListener) {
            nextButton.addEventListener('click', () => {
                setTimeout(() => {
                    if (globalIsPaired && !isHandlingRemoteSkip) {
                        globalPlayerManager.broadcast({
                            type: "skip_next",
                            data: {
                                timestamp: Date.now(),
                                controlUser: globalPeer?.id
                            }
                        });
                        globalPlayerManager.showNotification("Passando para a próxima música", "info");
                        lastControlUser = globalPeer?.id;
                        currentUserPriority = true;
                    }
                }, 100);
            });
            nextButton.hasTogetherListener = true;
            console.log("Together: Listener do botão próxima música adicionado");
        }

        // Tenta encontrar o botão de música anterior
        let prevButton = null;
        for (const selector of prevButtonSelectors) {
            prevButton = document.querySelector(selector);
            if (prevButton) break;
        }

        if (prevButton && !prevButton.hasTogetherListener) {
            prevButton.addEventListener('click', () => {
                setTimeout(() => {
                    if (globalIsPaired && !isHandlingRemoteSkip) {
                        globalPlayerManager.broadcast({
                            type: "skip_previous",
                            data: {
                                timestamp: Date.now(),
                                controlUser: globalPeer?.id
                            }
                        });
                        globalPlayerManager.showNotification("Voltando para a música anterior", "info");
                        lastControlUser = globalPeer?.id;
                        currentUserPriority = true;
                    }
                }, 100);
            });
            prevButton.hasTogetherListener = true;
            console.log("Together: Listener do botão música anterior adicionado");
        }
    };

    // Aplica os listeners imediatamente
    addNativeButtonListeners();

    // Re-aplica os listeners periodicamente caso a interface seja recarregada
    const intervalId = setInterval(addNativeButtonListeners, 2000);
    
    // Adiciona listener para mudanças no DOM
    const observer = new MutationObserver(() => {
        addNativeButtonListeners();
    });
    
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: false
    });

    // Salva referências para limpeza posterior se necessário
    window.togetherNativeListeners = { intervalId, observer };
}

// Função para configurar listeners de atalhos de teclado
function setupKeyboardListeners() {
    let lastTrackUri = null;
    let trackChangeDetectionActive = false;

    const handleTrackChangeDetection = () => {
        const currentTrackUri = Spicetify.Player.data?.item?.uri;
        
        if (trackChangeDetectionActive && currentTrackUri && currentTrackUri !== lastTrackUri) {
            setTimeout(() => {
                if (globalIsPaired && !isHandlingRemoteSkip && !isSyncing) {
                    const currentTrack = Spicetify.Player.data?.item;
                    if (currentTrack) {
                        globalPlayerManager.broadcast({
                            type: "track_change",
                            data: {
                                name: currentTrack.name || "Música Desconhecida",
                                artist: currentTrack.artists?.[0]?.name || "Artista Desconhecido",
                                album: currentTrack.album?.name || "Álbum Desconhecido",
                                duration: currentTrack.duration_ms || currentTrack.duration || 0,
                                uri: currentTrack.uri,
                                image: currentTrack.album?.images?.[0]?.url || null,
                            },
                            position: Spicetify.Player.getProgress(),
                            isPlaying: Spicetify.Player.isPlaying(),
                            timestamp: Date.now(),
                            controlUser: globalPeer?.id
                        });
                        lastControlUser = globalPeer?.id;
                        currentUserPriority = true;
                    }
                }
                trackChangeDetectionActive = false;
            }, 300);
        }
        
        lastTrackUri = currentTrackUri;
    };

    // Monitora mudanças de música continuamente
    setInterval(handleTrackChangeDetection, 500);

    // Listener para atalhos de teclado
    document.addEventListener('keydown', (event) => {
        if (!globalIsPaired || isHandlingRemoteSkip) return;

        // Verifica se não está em um campo de input
        if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') return;

        // Ctrl/Cmd + Seta Direita = Próxima música
        if ((event.ctrlKey || event.metaKey) && event.key === 'ArrowRight') {
            trackChangeDetectionActive = true;
            event.preventDefault();
        }
        
        // Ctrl/Cmd + Seta Esquerda = Música anterior  
        if ((event.ctrlKey || event.metaKey) && event.key === 'ArrowLeft') {
            trackChangeDetectionActive = true;
            event.preventDefault();
        }

        // Media keys (se suportados)
        if (event.key === 'MediaTrackNext') {
            trackChangeDetectionActive = true;
        }
        
        if (event.key === 'MediaTrackPrevious') {
            trackChangeDetectionActive = true;
        }
    });
}


// Nossa classe principal
class TogetherApp extends react.Component {
    constructor(props) {
        super(props);
        this.state = {
            isHost: globalIsHost,
            isPaired: globalIsPaired,
            peerId: "",
            remotePeerId: globalRemotePeerId,
            connections: [],
            statusMessage: globalIsPaired ? "Conectado à sessão" : "Aguardando conexão...",
            inputPeerId: "",
            loadingPeerJS: true,
            currentTrack: globalPlayerManager.currentTrack,
            currentPosition: globalPlayerManager.currentPosition,
            isPlaying: globalPlayerManager.isPlaying,
            peerConnectionStatus: "disconnected",
            notifications: [],
            roomMembers: [],
            currentVolume: Spicetify.Player.getVolume() * 100,
            showDebugPanel: false,
            debugLog: []
        };

        // Referências
        this.peer = null;
        this.connections = [];
    }

    async componentDidMount() {
        globalPlayerManager.register(this); // Registra o componente no gerenciador global

        try {
            if (globalPeer && globalPeer.open) {
                this.peer = globalPeer;
                this.connections = globalConnections;
                
                this.setState({
                    loadingPeerJS: false,
                    peerId: globalPeer.id,
                    isHost: globalIsHost,
                    isPaired: globalIsPaired,
                    remotePeerId: globalRemotePeerId,
                    connections: globalConnections,
                    roomMembers: globalRoomMembers,
                    peerConnectionStatus: globalIsPaired ? "connected" : "disconnected"
                });
                
                this.setupPeerListeners();
                return;
            }
            
            const Peer = await loadPeerJS();
            this.setState({ loadingPeerJS: false });
            
            let persistentPeerId = localStorage.getItem('together_peer_id') || 'user_' + Math.random().toString(36).substring(2, 10);
            localStorage.setItem('together_peer_id', persistentPeerId);
            
            this.peer = new Peer(persistentPeerId);
            globalPeer = this.peer;
            
            this.setupPeerListeners();

        } catch (error) {
            console.error("Failed to load PeerJS:", error);
            this.setState({ 
                statusMessage: "Falha ao carregar biblioteca P2P. Tente recarregar.",
                peerConnectionStatus: "error"
            });
        }
    }
    
    componentWillUnmount() {
        globalPlayerManager.unregister(); // Desregistra o componente

        // O estado da conexão é mantido nas variáveis globais
        globalConnections = this.connections;
        globalIsHost = this.state.isHost;
        globalIsPaired = this.state.isPaired;
        globalRemotePeerId = this.state.remotePeerId;
        globalRoomMembers = this.state.roomMembers;

        console.log("Componente desmontado, mantendo conexão e listeners ativos");
    }

    setupPeerListeners() {
        if (!this.peer) return;
        
        this.peer.on("open", (id) => {
            this.setState({ 
                peerId: id,
                statusMessage: "Conectado ao servidor P2P! Compartilhe seu ID ou conecte-se a um amigo."
            });
        });

        this.peer.on("connection", (conn) => {
            this.handleIncomingConnection(conn);
        });

        this.peer.on("error", (err) => {
            console.error("Peer error:", err);
            this.setState({ 
                statusMessage: `Erro na conexão P2P: ${err.message}`,
                peerConnectionStatus: "error" 
            });
        });
    }

    // Conecta-se a um peer remoto
    connectToPeer = () => {
        if (!this.state.inputPeerId || this.state.inputPeerId === this.state.peerId) {
            this.showNotification("ID inválido ou é seu próprio ID", "error");
            return;
        }

        this.setState({ statusMessage: "Conectando..." });
        
        const conn = this.peer.connect(this.state.inputPeerId, {
            reliable: true,
            metadata: { name: "Usuário do Spotify", peerId: this.state.peerId }
        });

        conn.on("open", () => this.handleConnectionOpen(conn, false));
        conn.on("error", (err) => {
            console.error("Connection error:", err);
            this.setState({ statusMessage: `Erro na conexão: ${err.message}`, peerConnectionStatus: "error" });
        });
    };

    handleIncomingConnection(conn) {
        conn.on("open", () => this.handleConnectionOpen(conn, true));
        conn.on("error", (err) => {
            console.error("Connection error:", err);
            this.showNotification(`Erro na conexão: ${err.message}`, "error");
        });
    }

    handleConnectionOpen(conn, isIncoming) {
        const existingConnIndex = this.connections.findIndex(c => c.peer === conn.peer);
        if (existingConnIndex !== -1) {
            this.connections[existingConnIndex].close();
            this.connections.splice(existingConnIndex, 1);
        }
        
        this.connections.push(conn);
        globalConnections.push(conn);
        
        const newMember = { peerId: conn.peer, name: conn.metadata?.name || "Usuário", isHost: !isIncoming };
        
        this.setState(prevState => {
            const filteredMembers = prevState.roomMembers.filter(m => m.peerId !== conn.peer);
            const newRoomMembers = [...filteredMembers, newMember];
            
            globalRoomMembers = newRoomMembers;
            globalIsHost = !isIncoming;
            globalIsPaired = true;
            globalRemotePeerId = conn.peer;
            
            return {
                isPaired: true,
                remotePeerId: conn.peer,
                isHost: !isIncoming,
                roomMembers: newRoomMembers,
                peerConnectionStatus: "connected",
                statusMessage: isIncoming ? "Alguém se conectou a você! Você é o host." : "Conectado com sucesso! Você está no modo convidado."
            };
        });

        conn.on("data", (data) => this.handleIncomingData(data, conn));
        conn.on("close", () => this.handleConnectionClose(conn));

        setTimeout(() => {
            if (isIncoming) {
                const currentTrack = globalPlayerManager.currentTrack;
                const isPlaying = Spicetify.Player.isPlaying();
                const position = Spicetify.Player.getProgress();
                
                conn.send({
                    type: "initial_state",
                    data: { track: currentTrack, isPlaying, position, peerId: this.state.peerId }
                });
                this.showNotification("Conectado! Enviando sua música atual para o convidado.", "success");
            } else {
                this.showNotification("Conectado! Aguardando sincronização com o host.", "info");
            }
        }, 1000);
    }

    handleConnectionClose(closedConn) {
        this.connections = this.connections.filter(conn => conn !== closedConn);
        globalConnections = globalConnections.filter(conn => conn !== closedConn);
        
        this.setState(prevState => {
            const newRoomMembers = prevState.roomMembers.filter(member => member.peerId !== closedConn.peer);
            globalRoomMembers = newRoomMembers;
            const stillConnected = this.connections.length > 0;
            globalIsPaired = stillConnected;
            
            return {
                roomMembers: newRoomMembers,
                isPaired: stillConnected,
                statusMessage: stillConnected ? `Um usuário desconectou.` : "A conexão foi encerrada.",
                peerConnectionStatus: stillConnected ? "connected" : "disconnected"
            };
        });
        this.showNotification("Um usuário se desconectou da sessão", "info");
    }

    handleIncomingData(data, conn) {
        console.log("Received data:", data);
        switch(data.type) {
            case "track_change":
                this.handleTrackChange(data.data, data.position, data.isPlaying, data.timestamp, data.controlUser);
                break;
            case "play_pause":
                this.handleRemotePlayPause(data.data);
                break;
            case "seek":
                this.handleRemoteSeek(data.data);
                break;
            case "skip_next":
                this.handleRemoteSkipNext(data.data);
                break;
            case "skip_previous":
                this.handleRemoteSkipPrevious(data.data);
                break;
            case "initial_state":
                this.handleInitialState(data.data);
                break;
            default:
                console.log("Unknown data type:", data.type);
        }
    }

    handleTrackChange(trackInfo, position, isPlaying, timestamp, controlUser) {
        isSyncing = true;
        lastControlUser = controlUser;
        currentUserPriority = (controlUser === this.state.peerId);
        
        globalPlayerManager.updateState({ currentTrack: trackInfo, currentPosition: position, isPlaying: isPlaying });
        
        const currentUri = Spicetify.Player.data?.item?.uri;
        if (currentUri !== trackInfo.uri) {
            this.showNotification(`Mudando para: ${trackInfo.name} - ${trackInfo.artist}`, "info");
            this.playTrack(trackInfo.uri, position, isPlaying, () => {
                isSyncing = false;
            });
        } else {
            if (Math.abs(Spicetify.Player.getProgress() - position) > 2000) {
                isHandlingRemoteSeek = true;
                Spicetify.Player.seek(position);
                setTimeout(() => { isHandlingRemoteSeek = false; }, 500);
            }
            if (isPlaying !== Spicetify.Player.isPlaying()) {
                isPlaying ? Spicetify.Player.play() : Spicetify.Player.pause();
            }
            isSyncing = false;
        }
    }

    handleRemotePlayPause(data) {
        const { isPlaying, timestamp, position } = data;
        isHandlingRemotePlayPause = true;
        
        const networkDelay = Date.now() - timestamp;
        const adjustedPosition = position + networkDelay;
        
        if (isPlaying) {
            if (position && Math.abs(Spicetify.Player.getProgress() - adjustedPosition) > 1000) {
                Spicetify.Player.seek(adjustedPosition);
            }
            Spicetify.Player.play();
        } else {
            Spicetify.Player.pause();
        }
        
        globalPlayerManager.updateState({ isPlaying, currentPosition: position });
        setTimeout(() => { isHandlingRemotePlayPause = false; }, 500);
    }

    handleRemoteSeek(data) {
        const { position } = data;
        isHandlingRemoteSeek = true;
        Spicetify.Player.seek(position);
        globalPlayerManager.updateState({ currentPosition: position });
        setTimeout(() => { isHandlingRemoteSeek = false; }, 500);
    }

    handleRemoteSkipNext(data) {
        const { timestamp, controlUser } = data;
        if (controlUser !== this.state.peerId) {
            isHandlingRemoteSkip = true;
            this.showNotification("Passando para a próxima música", "info");
            Spicetify.Player.next();
            lastControlUser = controlUser;
            currentUserPriority = false;
            setTimeout(() => { isHandlingRemoteSkip = false; }, 2000);
        }
    }

    handleRemoteSkipPrevious(data) {
        const { timestamp, controlUser } = data;
        if (controlUser !== this.state.peerId) {
            isHandlingRemoteSkip = true;
            this.showNotification("Voltando para a música anterior", "info");
            Spicetify.Player.back();
            lastControlUser = controlUser;
            currentUserPriority = false;
            setTimeout(() => { isHandlingRemoteSkip = false; }, 2000);
        }
    }

    handleInitialState(data) {
        isSyncing = true;
        isHandlingRemotePlayPause = true;
        isHandlingRemoteSeek = true;
        
        if (data.track && data.track.uri) {
            globalPlayerManager.updateState({
                currentTrack: data.track,
                currentPosition: data.position,
                isPlaying: data.isPlaying
            });
            
            setTimeout(() => {
                this.playTrack(data.track.uri, data.position, data.isPlaying, () => {
                    isSyncing = false;
                    setTimeout(() => {
                        isHandlingRemotePlayPause = false;
                        isHandlingRemoteSeek = false;
                    }, 1000);
                });
            }, 300);
            this.showNotification(`Sincronizando com: ${data.track.name}`, "info");
        } else {
            isSyncing = false;
            isHandlingRemotePlayPause = false;
            isHandlingRemoteSeek = false;
        }
    }

    playTrack(uri, position = 0, shouldPlay = true, callback = null) {
        Spicetify.Player.playUri(uri).then(() => {
            setTimeout(() => {
                if (Math.abs(Spicetify.Player.getProgress() - position) > 2000) {
                    Spicetify.Player.seek(position);
                }
                if (shouldPlay !== Spicetify.Player.isPlaying()) {
                    shouldPlay ? Spicetify.Player.play() : Spicetify.Player.pause();
                }
                if (callback) callback();
            }, 500);
        }).catch(err => {
            console.error("Erro ao tocar faixa:", err);
            this.showNotification("Não foi possível tocar a faixa.", "error");
            if (callback) callback();
        });
    }

    broadcastToAll(message) {
        this.connections.forEach(conn => {
            if (conn.open) conn.send(message);
        });
    }

    playPauseTrack = () => {
        this.state.isPlaying ? Spicetify.Player.pause() : Spicetify.Player.play();
        // O listener global handlePlayPause cuidará da sincronização
    };

    seekTrack = (position) => {
        Spicetify.Player.seek(position);
        // O listener global handleProgress cuidará da sincronização
    };

    changeVolume = (volume) => {
        Spicetify.Player.setVolume(volume / 100);
        this.setState({ currentVolume: volume });
    };

    skipToNext = () => {
        Spicetify.Player.next();
        
        if (globalIsPaired) {
            this.broadcastToAll({
                type: "skip_next",
                data: {
                    timestamp: Date.now(),
                    controlUser: this.state.peerId
                }
            });
            this.showNotification("Passando para a próxima música", "info");
            lastControlUser = this.state.peerId;
            currentUserPriority = true;
        }
    };

    skipToPrevious = () => {
        Spicetify.Player.back();
        
        if (globalIsPaired) {
            this.broadcastToAll({
                type: "skip_previous", 
                data: {
                    timestamp: Date.now(),
                    controlUser: this.state.peerId
                }
            });
            this.showNotification("Voltando para a música anterior", "info");
            lastControlUser = this.state.peerId;
            currentUserPriority = true;
        }
    };

    disconnectSession = () => {
        this.connections.forEach(conn => conn.close());
        this.connections = [];
        globalConnections.forEach(conn => conn.close());
        globalConnections = [];
        globalIsHost = false;
        globalIsPaired = false;
        globalRemotePeerId = "";
        globalRoomMembers = [];
        
        this.setState({
            isPaired: false,
            isHost: false,
            remotePeerId: "",
            roomMembers: [],
            statusMessage: "Desconectado.",
            peerConnectionStatus: "disconnected"
        });
        
        if (this.peer) {
            this.peer.destroy();
            const persistentPeerId = localStorage.getItem('together_peer_id');
            setTimeout(() => {
                this.peer = new Peer(persistentPeerId);
                globalPeer = this.peer;
                this.setupPeerListeners();
                this.setState({ peerId: persistentPeerId });
            }, 1000);
        }
        this.showNotification("Desconectado da sessão", "info");
    };

    showNotification(message, type = "info") {
        const id = Date.now();
        const notification = { id, message, type };
        this.setState(prevState => ({ notifications: [...prevState.notifications, notification] }));
        setTimeout(() => {
            this.setState(prevState => ({
                notifications: prevState.notifications.filter(n => n.id !== id)
            }));
        }, 5000);
    }

    render() {
        const { 
            statusMessage, peerId, inputPeerId, isPaired, isHost,
            loadingPeerJS, currentTrack, isPlaying,
            currentPosition, currentVolume, notifications, roomMembers
        } = this.state;
        
        const styles = {
            container: { padding: "16px", fontFamily: "var(--font-family, sans-serif)", color: "var(--spice-text)" },
            card: { background: "var(--spice-card)", borderRadius: "8px", padding: "16px", marginBottom: "16px" },
            inputGroup: { display: "flex", marginBottom: "16px" },
            input: { flex: 1, padding: "8px 12px", borderRadius: "4px", border: "1px solid var(--spice-button-disabled)", background: "var(--spice-main)", color: "var(--spice-text)" },
            button: { padding: "8px 16px", borderRadius: "4px", border: "none", background: "var(--spice-button-primary)", color: "var(--spice-button-primary-foreground)", marginLeft: "8px", cursor: "pointer" },
            disconnectButton: { background: "var(--spice-notification-error)", color: "white" },
            peerIdDisplayContainer: { display: "flex", alignItems: "center", marginBottom: "16px" },
            peerIdDisplay: { fontFamily: "monospace", padding: "8px", background: "var(--spice-main-elevated)", borderRadius: "4px 0 0 4px", flex: 1 },
            copyButton: { padding: "8px 12px", background: "var(--spice-button)", border: "none", borderRadius: "0 4px 4px 0", cursor: "pointer" },
            playerControls: { display: "flex", alignItems: "center", justifyContent: "center", marginTop: "16px", gap: "8px" },
            playButton: { background: "transparent", border: "none", cursor: "pointer", color: "var(--spice-text)", fontSize: "24px", padding: "8px" },
            skipButton: { background: "transparent", border: "none", cursor: "pointer", color: "var(--spice-text)", fontSize: "20px", padding: "8px" },
            slider: { width: "100%", margin: "0 16px" },
            volumeControl: { display: "flex", alignItems: "center", marginTop: "16px" },
            volumeSlider: { flex: 1, marginLeft: "8px" },
            trackInfo: { textAlign: "center", marginBottom: "16px" },
            trackTitle: { fontSize: "16px", fontWeight: "bold", marginBottom: "4px" },
            trackArtist: { fontSize: "14px", color: "var(--spice-subtext)" },
            notificationsContainer: { position: "fixed", bottom: "16px", right: "16px", zIndex: 1000 },
            notification: (type) => ({ padding: "12px", marginBottom: "8px", borderRadius: "4px", backgroundColor: type === "error" ? "var(--spice-notification-error)" : "var(--spice-notification-information)", color: "white", boxShadow: "0 2px 8px rgba(0,0,0,0.2)" })
        };

        return react.createElement("div", { style: styles.container },
            react.createElement("h1", null, "Together"),
            react.createElement("div", { style: styles.card },
                react.createElement("p", null, statusMessage),
                !loadingPeerJS && !isPaired && react.createElement("div", null,
                    react.createElement("div", { style: styles.peerIdDisplayContainer },
                        react.createElement("div", { style: styles.peerIdDisplay }, peerId),
                        react.createElement("button", { style: styles.copyButton, onClick: () => navigator.clipboard.writeText(peerId).then(() => this.showNotification("ID copiado!", "success")) }, "📋")
                    ),
                    react.createElement("div", { style: styles.inputGroup },
                        react.createElement("input", { type: "text", style: styles.input, placeholder: "ID do amigo", value: inputPeerId, onChange: (e) => this.setState({ inputPeerId: e.target.value }) }),
                        react.createElement("button", { style: styles.button, onClick: this.connectToPeer }, "Conectar")
                    )
                ),
                isPaired && react.createElement("button", { style: {...styles.button, ...styles.disconnectButton}, onClick: this.disconnectSession }, "Desconectar"),
                loadingPeerJS && react.createElement("p", null, "Carregando P2P...")
            ),
            isPaired && react.createElement("div", { style: styles.card },
                react.createElement("h3", null, "Participantes"),
                react.createElement("ul", null,
                    react.createElement("li", null, `Você ${isHost ? "(Host)" : "(Convidado)"}`),
                    roomMembers.map(member => react.createElement("li", { key: member.peerId }, `${member.name} ${member.isHost ? "(Host)" : "(Convidado)"}`))
                )
            ),
            currentTrack && react.createElement("div", { style: styles.card },
                react.createElement("h3", null, "Controles de Música"),
                react.createElement("div", { style: styles.trackInfo },
                    react.createElement("div", { style: styles.trackTitle }, currentTrack.name),
                    react.createElement("div", { style: styles.trackArtist }, currentTrack.artist)
                ),
                react.createElement("div", { style: styles.playerControls },
                    react.createElement("button", { 
                        style: styles.skipButton, 
                        onClick: this.skipToPrevious,
                        title: "Música anterior"
                    }, "⏮"),
                    react.createElement("button", { 
                        style: styles.playButton, 
                        onClick: this.playPauseTrack,
                        title: isPlaying ? "Pausar" : "Reproduzir"
                    }, isPlaying ? "⏸" : "▶"),
                    react.createElement("button", { 
                        style: styles.skipButton, 
                        onClick: this.skipToNext,
                        title: "Próxima música"
                    }, "⏭")
                )
            ),
            react.createElement("div", { style: styles.notificationsContainer },
                notifications.map(n => react.createElement("div", { key: n.id, style: styles.notification(n.type) }, n.message))
            )
        );
    }
}
