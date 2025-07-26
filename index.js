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
            currentTrack: null,
            currentPosition: 0,
            isPlaying: false,
            peerConnectionStatus: "disconnected",
            notifications: [],
            roomMembers: [],
            currentVolume: Spicetify.Player.getVolume() * 100,
        };

        // Referências
        this.peer = null;
        this.connections = [];
        this.currentTrackInterval = null;
        this.playerStateInterval = null;
    }

    async componentDidMount() {
        try {
            // Se já temos uma conexão global, reuse
            if (globalPeer && globalPeer.open) {
                console.log("Reusando conexão PeerJS existente");
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
                
                // Re-configure os event listeners para este novo componente
                this.setupPeerListeners();
                this.setupSpotifyListeners();
                
                return;
            }
            
            // Carrega a biblioteca PeerJS dinamicamente
            const Peer = await loadPeerJS();
            this.setState({ loadingPeerJS: false });
            
            // Usa um ID persistente ou cria um novo
            let persistentPeerId = localStorage.getItem('together_peer_id');
            
            // Se não existir um ID salvo, cria e salva
            if (!persistentPeerId) {
                persistentPeerId = 'user_' + Math.random().toString(36).substring(2, 10);
                localStorage.setItem('together_peer_id', persistentPeerId);
            }
            
            console.log("Usando ID persistente:", persistentPeerId);
            
            // Inicializa o peer com o ID persistente
            this.peer = new Peer(persistentPeerId);
            // Salva a referência global
            globalPeer = this.peer;
            
            // Configura os listeners do peer
            this.setupPeerListeners();
            
            // Configuração dos event listeners do Spotify
            this.setupSpotifyListeners();

            // Mantém os listeners ativos globalmente
            if (!globalTrackInterval) {
                globalTrackInterval = setInterval(() => {
                    this.updateCurrentTrack();
                }, 3000);
            }

            if (!globalPlayerStateInterval) {
                globalPlayerStateInterval = setInterval(() => {
                    this.updatePlayerState();
                }, 1000);
            }

        } catch (error) {
            console.error("Failed to load PeerJS:", error);
            this.setState({ 
                statusMessage: "Falha ao carregar biblioteca P2P. Tente recarregar.",
                peerConnectionStatus: "error"
            });
        }
    }

    // Configura os listeners do peer
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
    
    componentWillUnmount() {
        // Limpa apenas os intervalos locais
        if (this.currentTrackInterval) clearInterval(this.currentTrackInterval);
        if (this.playerStateInterval) clearInterval(this.playerStateInterval);

        // Atualiza as variáveis globais para manter o estado
        globalConnections = this.connections;
        globalIsHost = this.state.isHost;
        globalIsPaired = this.state.isPaired;
        globalRemotePeerId = this.state.remotePeerId;
        globalRoomMembers = this.state.roomMembers;

        // Remove os listeners do Spotify apenas localmente
        Spicetify.Player.removeEventListener("songchange", this.handleSongChange);
        Spicetify.Player.removeEventListener("onplaypause", this.handlePlayPause);
        Spicetify.Player.removeEventListener("onprogress", this.handleProgress);

        console.log("Componente desmontado, mantendo conexão ativa");
    }

    setupSpotifyListeners() {
        // Monitor de alterações de faixa
        Spicetify.Player.addEventListener("songchange", this.handleSongChange);
        
        // Monitor de play/pause
        Spicetify.Player.addEventListener("onplaypause", this.handlePlayPause);
        
        // Monitor de progresso da faixa
        Spicetify.Player.addEventListener("onprogress", this.handleProgress);
        
        // Sincronização inicial
        this.updateCurrentTrack();
        
        // Polling para verificar alterações em intervalos regulares
        this.currentTrackInterval = setInterval(() => {
            this.updateCurrentTrack();
        }, 3000);
        
        this.playerStateInterval = setInterval(() => {
            this.updatePlayerState();
        }, 1000);
    }

    // Atualiza as informações da faixa atual
    updateCurrentTrack = (forceSync = false) => {
        const playerData = Spicetify.Player.data;
        if (!playerData || !playerData.item) {
            console.log("[DEBUG] Player data não disponível:", playerData);
            return;
        }
        
        const currentTrack = playerData.item;
        console.log("[DEBUG] Player data structure:", playerData);
        console.log("[DEBUG] Current track structure:", currentTrack);
        
        const trackInfo = {
            name: currentTrack.name || currentTrack.metadata?.title || "Música Desconhecida",
            artist: (currentTrack.artists && currentTrack.artists[0]?.name) || 
                   currentTrack.metadata?.artist_name || 
                   "Artista Desconhecido",
            album: currentTrack.album?.name || 
                  currentTrack.metadata?.album_title || 
                  "Álbum Desconhecido",
            duration: currentTrack.duration_ms || currentTrack.duration || 0,
            uri: currentTrack.uri,
            image: currentTrack.album?.images?.[0]?.url || 
                  currentTrack.metadata?.image_url || null,
            contextUri: playerData.context?.uri || null,
            contextType: playerData.context?.type || null
        };
        
        console.log("[DEBUG] Track info extraído:", trackInfo);
        
        // Compara se a música mudou usando o URI
        const trackChanged = !this.state.currentTrack || 
                            this.state.currentTrack.uri !== trackInfo.uri;
        
        if (trackChanged || forceSync) {
            console.log("[DEBUG] Track changed to:", trackInfo.name, "isSyncing:", isSyncing);
            this.setState({ currentTrack: trackInfo });
            
            // Qualquer usuário conectado pode enviar atualizações de faixa
            // MAS apenas se não estivermos em processo de sincronização
            if (this.state.isPaired && !isSyncing) {
                const now = Date.now();
                
                // Evita enviar mudanças muito rápidas (debounce de 1 segundo)
                if (now - lastSyncTime < 1000) {
                    console.log("[DEBUG] Ignorando mudança muito rápida, aguardando debounce");
                    return;
                }
                
                lastSyncTime = now;
                
                // Aguarda um pouco para garantir que a música esteja realmente carregada
                setTimeout(() => {
                    // Verifica novamente se não estamos sincronizando
                    if (isSyncing) {
                        console.log("[DEBUG] Cancelando envio - sincronização em andamento");
                        return;
                    }
                    
                    const currentPosition = Spicetify.Player.getProgress();
                    const isPlaying = Spicetify.Player.isPlaying();
                    
                    console.log("[DEBUG] Enviando mudança de faixa:", trackInfo.name);
                    
                    this.broadcastToAll({
                        type: "track_change",
                        data: trackInfo,
                        position: currentPosition,
                        isPlaying: isPlaying,
                        timestamp: now // Adiciona timestamp para identificar a origem
                    });
                    
                    // Adiciona uma notificação sobre a mudança de música
                    if (trackChanged) {
                        this.showNotification(`Alterou para: ${trackInfo.name} - ${trackInfo.artist}`, "info");
                    }
                }, 800);
            }
        } else if (JSON.stringify(trackInfo) !== JSON.stringify(this.state.currentTrack)) {
            // Atualiza outras informações da faixa que possam ter mudado, mas não o URI
            this.setState({ currentTrack: trackInfo });
        }
    };

    // Atualiza o estado do player (play/pause, posição)
    updatePlayerState = () => {
        const isPlaying = Spicetify.Player.isPlaying();
        const currentPosition = Spicetify.Player.getProgress();
        const currentVolume = Spicetify.Player.getVolume() * 100;
        
        // Atualiza o estado local
        if (isPlaying !== this.state.isPlaying || 
            Math.abs(currentPosition - this.state.currentPosition) > 1000 ||
            currentVolume !== this.state.currentVolume) {
            
            this.setState({ 
                isPlaying, 
                currentPosition,
                currentVolume // O volume é mantido localmente apenas, não é sincronizado
            });
            
            // Qualquer usuário conectado pode enviar atualizações de estado
            if (this.state.isPaired) {
                // Apenas envia se for uma alteração significativa
                // para evitar loop de atualizações entre usuários
                if (isPlaying !== this.state.isPlaying || 
                    Math.abs(currentPosition - this.state.currentPosition) > 3000) {
                    
                    this.broadcastToAll({
                        type: "player_state",
                        data: {
                            isPlaying,
                            position: currentPosition
                            // Volume NUNCA é sincronizado - cada usuário controla seu próprio volume
                        }
                    });
                }
            }
        }
    };

    // Handlers para eventos do Spotify
    handleSongChange = () => {
        // Atualiza a faixa atual e envia para todos, independente de ser host ou não
        this.updateCurrentTrack(true);
    };

    handlePlayPause = () => {
        const isPlaying = Spicetify.Player.isPlaying();
        this.setState({ isPlaying });
        
        // Qualquer usuário pode enviar comandos de play/pause
        if (this.state.isPaired) {
            this.broadcastToAll({
                type: "play_pause",
                data: { isPlaying }
            });
        }
    };

    handleProgress = () => {
        // Atualizado pelo interval para evitar excesso de eventos
    };

    // Conecta-se a um peer remoto
    connectToPeer = () => {
        if (!this.state.inputPeerId || this.state.inputPeerId === this.state.peerId) {
            this.showNotification("ID inválido ou é seu próprio ID", "error");
            return;
        }

        this.setState({ statusMessage: "Conectando..." });
        
        const conn = this.peer.connect(this.state.inputPeerId, {
            reliable: true,
            metadata: { 
                name: "Usuário do Spotify", 
                peerId: this.state.peerId 
            }
        });

        conn.on("open", () => {
            this.handleConnectionOpen(conn, false);
        });

        conn.on("error", (err) => {
            console.error("Connection error:", err);
            this.setState({ 
                statusMessage: `Erro na conexão: ${err.message}`,
                peerConnectionStatus: "error" 
            });
        });
    };

    // Manipula uma conexão entrante
    handleIncomingConnection(conn) {
        conn.on("open", () => {
            this.handleConnectionOpen(conn, true);
        });

        conn.on("error", (err) => {
            console.error("Connection error:", err);
            this.showNotification(`Erro na conexão: ${err.message}`, "error");
        });
    }

    // Manipula uma conexão estabelecida
    handleConnectionOpen(conn, isIncoming) {
        // Adiciona à lista de conexões
        this.connections.push(conn);
        globalConnections.push(conn);
        
        // Prepara o novo membro
        const newMember = {
            peerId: conn.peer,
            name: conn.metadata?.name || "Usuário",
            isHost: !isIncoming
        };
        
        // Atualiza o estado local e global
        this.setState(prevState => {
            const newRoomMembers = [...prevState.roomMembers, newMember];
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
                statusMessage: isIncoming 
                    ? "Alguém se conectou a você! Você é o host." 
                    : "Conectado com sucesso! Você está no modo convidado."
            };
        });

        // Configura o handler de dados
        conn.on("data", (data) => {
            this.handleIncomingData(data, conn);
        });

        // Configura o handler de fechamento
        conn.on("close", () => {
            this.handleConnectionClose(conn);
        });

        // Sincronização inicial - apenas o HOST envia seu estado para evitar loops
        // Aguarda um momento para garantir que a conexão está estabelecida
        setTimeout(() => {
            // Apenas o HOST (quem recebeu a conexão) envia seu estado inicial
            if (isIncoming) {
                // Host envia seu estado atual para o convidado
                const currentTrack = this.state.currentTrack;
                const isPlaying = Spicetify.Player.isPlaying();
                const position = Spicetify.Player.getProgress();
                
                console.log("[DEBUG] Host enviando estado inicial:", { currentTrack, isPlaying, position });
                
                conn.send({
                    type: "initial_state",
                    data: {
                        track: currentTrack,
                        isPlaying: isPlaying,
                        position: position,
                        peerId: this.state.peerId
                        // Volume NUNCA é incluído - é sempre individual
                    }
                });
                
                this.showNotification("Conectado! Enviando sua música atual para o convidado.", "success");
            } else {
                // Convidado apenas aguarda receber o estado do host
                this.showNotification("Conectado! Aguardando sincronização com o host.", "info");
            }
        }, 1000);
    }

    // Manipula o fechamento de uma conexão
    handleConnectionClose(closedConn) {
        // Remove da lista de conexões
        this.connections = this.connections.filter(conn => conn !== closedConn);
        globalConnections = globalConnections.filter(conn => conn !== closedConn);
        
        // Atualiza a lista de membros
        this.setState(prevState => {
            const newRoomMembers = prevState.roomMembers.filter(
                member => member.peerId !== closedConn.peer
            );
            
            // Atualiza as variáveis globais
            globalRoomMembers = newRoomMembers;
            const stillConnected = this.connections.length > 0;
            globalIsPaired = stillConnected;
            
            return {
                roomMembers: newRoomMembers,
                isPaired: stillConnected,
                statusMessage: stillConnected
                    ? `Um usuário desconectou. Ainda conectado com ${this.connections.length} usuário(s).`
                    : "A conexão foi encerrada. Aguardando nova conexão...",
                peerConnectionStatus: stillConnected ? "connected" : "disconnected"
            };
        });
        
        this.showNotification("Um usuário se desconectou da sessão", "info");
    }

    // Manipula dados recebidos
    handleIncomingData(data, conn) {
        console.log("Received data:", data);
        
        switch(data.type) {
            case "track_change":
                this.handleTrackChange(data.data, data.position, data.isPlaying, data.timestamp);
                break;
                
            case "play_pause":
                this.handleRemotePlayPause(data.data.isPlaying);
                break;
                
            case "seek":
                this.handleRemoteSeek(data.data.position);
                break;
                
            case "initial_state":
                this.handleInitialState(data.data);
                break;
                
            case "player_state":
                this.handleRemotePlayerState(data.data);
                break;
                
            case "chat_message":
                this.handleChatMessage(data.data, conn.peer);
                break;
                
            default:
                console.log("Unknown data type:", data.type);
        }
    }

    // Manipula a mudança de faixa recebida com sincronização aprimorada
    handleTrackChange(trackInfo, position, isPlaying, timestamp) {
        console.log("[DEBUG] Recebida solicitação de mudança de faixa:", trackInfo.name, "timestamp:", timestamp);
        
        // Marca que estamos sincronizando para evitar loops
        isSyncing = true;
        
        // Sempre atualiza o estado local primeiro para refletir o que será tocado
        this.setState({ 
            currentTrack: trackInfo,
            currentPosition: position,
            isPlaying: isPlaying
        });
        
        // Verifica se estamos tocando a mesma música
        const currentUri = Spicetify.Player.data?.item?.uri;
        
        if (currentUri !== trackInfo.uri) {
            // Se a música for diferente, força a mudança
            console.log("[DEBUG] Mudando para nova faixa:", trackInfo.name);
            
            // Mostra notificação antes da mudança
            this.showNotification(
                `Mudando para: ${trackInfo.name} - ${trackInfo.artist}`,
                "info"
            );
            
            // Reproduz a faixa com a posição e estado atualizados
            this.playTrack(trackInfo.uri, position, isPlaying, () => {
                // Callback executado após tentar tocar
                setTimeout(() => {
                    isSyncing = false; // Libera sincronização após um delay
                    console.log("[DEBUG] Sincronização liberada após mudança de faixa");
                }, 2000);
            });
            
        } else if (Math.abs(Spicetify.Player.getProgress() - position) > 2000) {
            // Se for a mesma música mas a posição divergiu muito, sincroniza
            Spicetify.Player.seek(position);
            console.log("[DEBUG] Sincronizando posição para:", position);
            
            // Sincroniza também o estado de reprodução
            if (isPlaying !== Spicetify.Player.isPlaying()) {
                isPlaying ? Spicetify.Player.play() : Spicetify.Player.pause();
            }
            
            this.showNotification(`Sincronizado posição na faixa`, "info");
            
            // Libera sincronização mais rapidamente para ajustes de posição
            setTimeout(() => {
                isSyncing = false;
                console.log("[DEBUG] Sincronização liberada após ajuste de posição");
            }, 500);
            
        } else {
            // Se for a mesma música e posição similar, apenas sincroniza o estado de reprodução
            if (isPlaying !== Spicetify.Player.isPlaying()) {
                isPlaying ? Spicetify.Player.play() : Spicetify.Player.pause();
                this.showNotification(
                    isPlaying ? "Reprodução sincronizada" : "Pausa sincronizada", 
                    "info"
                );
            }
            
            // Libera sincronização rapidamente para mudanças simples
            setTimeout(() => {
                isSyncing = false;
                console.log("[DEBUG] Sincronização liberada após ajuste de estado");
            }, 200);
        }
    }

    // Manipula o comando de play/pause recebido
    handleRemotePlayPause(isPlaying) {
        // Qualquer usuário responde às mudanças de play/pause
        if (isPlaying) {
            Spicetify.Player.play();
            this.showNotification("Reprodução iniciada remotamente", "info");
        } else {
            Spicetify.Player.pause();
            this.showNotification("Reprodução pausada remotamente", "info");
        }
        this.setState({ isPlaying });
    }

    // Manipula o comando de seek recebido
    handleRemoteSeek(position) {
        // Qualquer usuário responde às mudanças de posição
        Spicetify.Player.seek(position);
        this.setState({ currentPosition: position });
    }

    // Manipula o estado inicial recebido do host
    handleInitialState(data) {
        console.log("[DEBUG] Recebendo estado inicial do host:", data);
        
        // Marca que estamos sincronizando
        isSyncing = true;
        
        if (data.track && data.track.uri) {
            // Atualiza o estado local primeiro
            this.setState({
                currentTrack: data.track,
                currentPosition: data.position,
                isPlaying: data.isPlaying
            });
            
            // Espera um breve momento antes de reproduzir
            // Isso garante que o estado tenha sido atualizado
            setTimeout(() => {
                // Tenta reproduzir a faixa do host
                console.log("[DEBUG] Sincronizando estado inicial com música do host:", data.track.name);
                this.playTrack(data.track.uri, data.position, data.isPlaying, () => {
                    // Libera a sincronização após completar
                    setTimeout(() => {
                        isSyncing = false;
                        console.log("[DEBUG] Sincronização inicial concluída");
                    }, 3000);
                });
                
            }, 500);
            
            this.showNotification(`Sincronizando com música do host: ${data.track.name} - ${data.track.artist}`, "info");
        } else {
            console.log("[DEBUG] Host não possui música tocando no momento");
            this.showNotification("Host não está tocando música no momento", "info");
            // Libera a sincronização imediatamente
            isSyncing = false;
        }
    }

    // Manipula o estado do player recebido
    handleRemotePlayerState(state) {
        // Todos os usuários respondem a atualizações de estado
        
        // Sincroniza o estado de reprodução
        if (state.isPlaying !== this.state.isPlaying) {
            state.isPlaying ? Spicetify.Player.play() : Spicetify.Player.pause();
        }
        
        // Sincroniza a posição se houver diferença maior que 2 segundos
        const currentPosition = Spicetify.Player.getProgress();
        if (Math.abs(currentPosition - state.position) > 2000) {
            Spicetify.Player.seek(state.position);
        }
        
        // Volume não é sincronizado - cada usuário controla seu próprio volume
    }

    // Manipula mensagens de chat
    handleChatMessage(messageData, senderId) {
        const sender = this.state.roomMembers.find(m => m.peerId === senderId) || 
                      { name: "Usuário", peerId: senderId };
        
        this.showNotification(`${sender.name}: ${messageData.message}`, "chat");
    }

    // Reproduz uma faixa específica com sincronização aprimorada
    playTrack(uri, position = 0, shouldPlay = true, callback = null) {
        // Registra o que está acontecendo para debug
        console.log(`[DEBUG] Tocando faixa: ${uri}, posição: ${position}ms, play: ${shouldPlay}`);
        
        // Força a reprodução da URI, ignorando o estado atual
        try {
            // Tenta usar o método mais direto primeiro
            console.log("[DEBUG] Forçando reprodução da URI:", uri);
            
            // Usa o método playUri que aceita URIs de música
            Spicetify.Player.playUri(uri);
            
            // Registra a tentativa
            this.showNotification(`Tocando: ${uri.split(":")[2] || uri}`, "info");
            
            // Aguarda um tempo para que a música carregue e então sincroniza o estado
            setTimeout(() => {
                // Verifica se a música está correta
                const currentUri = Spicetify.Player.data?.item?.uri;
                
                if (currentUri === uri) {
                    console.log("[DEBUG] Música carregada com sucesso:", uri);
                    
                    // Ajusta a posição se necessário
                    if (Math.abs(Spicetify.Player.getProgress() - position) > 2000) {
                        Spicetify.Player.seek(position);
                    }
                    
                    // Ajusta o estado de reprodução
                    if (shouldPlay && !Spicetify.Player.isPlaying()) {
                        Spicetify.Player.play();
                    } else if (!shouldPlay && Spicetify.Player.isPlaying()) {
                        Spicetify.Player.pause();
                    }
                    
                    // Executa callback se fornecido
                    if (callback) callback();
                    
                } else {
                    console.warn("[DEBUG] URI não corresponde após tentativa de reprodução!", 
                                "Esperado:", uri, "Atual:", currentUri);
                    
                    // Tenta um método alternativo com mais parâmetros
                    Spicetify.Player.playUri(uri, {}, { 
                        seek: position,
                        skipTo: { uri: uri }
                    });
                    
                    // Verifica novamente após um tempo
                    setTimeout(() => {
                        if (shouldPlay) {
                            Spicetify.Player.play();
                        } else {
                            Spicetify.Player.pause();
                        }
                        
                        // Ajusta a posição novamente
                        Spicetify.Player.seek(position);
                        
                        // Executa callback se fornecido
                        if (callback) callback();
                    }, 500);
                }
            }, 1000);
            
        } catch (error) {
            console.error("[DEBUG] Erro ao reproduzir faixa:", error);
            this.showNotification(`Erro ao reproduzir: ${error.message}`, "error");
            
            // Tenta método alternativo em caso de erro
            try {
                console.log("[DEBUG] Tentando método alternativo para tocar:", uri);
                
                // Método alternativo que pode funcionar em alguns casos
                const uriObj = Spicetify.URI.fromString(uri);
                Spicetify.Player.play(uriObj);
                
                // Sincroniza após algum tempo
                setTimeout(() => {
                    Spicetify.Player.seek(position);
                    
                    if (!shouldPlay) {
                        Spicetify.Player.pause();
                    }
                    
                    // Executa callback se fornecido
                    if (callback) callback();
                }, 1000);
            } catch (secondError) {
                console.error("[DEBUG] Erro no método alternativo:", secondError);
                this.showNotification("Não foi possível reproduzir esta música", "error");
                
                // Executa callback mesmo em caso de erro
                if (callback) callback();
            }
        }
    }

    // Enviar uma mensagem para todos os peers conectados
    broadcastToAll(message) {
        this.connections.forEach(conn => {
            if (conn.open) {
                conn.send(message);
            }
        });
    }

    // Ações de controle de mídia que podem ser iniciadas por qualquer usuário
    playPauseTrack = () => {
        const isPlaying = !this.state.isPlaying;
        
        if (isPlaying) {
            Spicetify.Player.play();
        } else {
            Spicetify.Player.pause();
        }
        
        this.setState({ isPlaying });
        
        // Qualquer usuário pode enviar comandos de play/pause
        if (this.state.isPaired) {
            this.broadcastToAll({
                type: "play_pause",
                data: { isPlaying }
            });
            
            // Mostra uma notificação sobre a ação
            this.showNotification(
                isPlaying ? "Reproduzindo música para todos" : "Música pausada para todos", 
                "info"
            );
        }
    };

    seekTrack = (position) => {
        Spicetify.Player.seek(position);
        
        // Qualquer usuário pode enviar comandos de seek
        if (this.state.isPaired) {
            this.broadcastToAll({
                type: "seek",
                data: { position }
            });
            
            // Notifica a mudança de posição
            this.showNotification("Alterando posição para todos", "info");
        }
    };

    changeVolume = (volume) => {
        // Altera apenas o volume local - NUNCA é sincronizado com outros usuários
        Spicetify.Player.setVolume(volume / 100);
        this.setState({ currentVolume: volume });
        
        // Volume não é sincronizado entre os usuários
        // Cada usuário controla seu próprio volume independentemente
        // Não enviamos nenhuma mensagem de sincronização aqui
    };

    // Desconecta da sessão atual
    disconnectSession = () => {
        // Fecha todas as conexões
        this.connections.forEach(conn => conn.close());
        this.connections = [];
        
        // Limpa as variáveis globais
        globalConnections = [];
        globalIsHost = false;
        globalIsPaired = false;
        globalRemotePeerId = "";
        globalRoomMembers = [];
        
        // Reinicia o estado
        this.setState({
            isPaired: false,
            isHost: false,
            remotePeerId: "",
            roomMembers: [],
            statusMessage: "Desconectado. Inicie uma nova sessão.",
            peerConnectionStatus: "disconnected"
        });
        
        // Recria o peer para evitar problemas com conexões anteriores
        if (this.peer) {
            this.peer.destroy();
            
            // Recupera o ID persistente
            const persistentPeerId = localStorage.getItem('together_peer_id');
            
            // Cria um novo peer com o mesmo ID
            setTimeout(() => {
                this.peer = new Peer(persistentPeerId);
                globalPeer = this.peer;
                this.setupPeerListeners();
                
                this.setState({
                    peerId: persistentPeerId
                });
            }, 1000);
        }
        
        this.showNotification("Desconectado da sessão", "info");
    };

    // Mostra uma notificação temporária
    showNotification(message, type = "info") {
        const id = Date.now();
        const notification = { id, message, type };
        
        this.setState(prevState => ({
            notifications: [...prevState.notifications, notification]
        }));
        
        // Remove a notificação após um tempo
        setTimeout(() => {
            this.setState(prevState => ({
                notifications: prevState.notifications.filter(n => n.id !== id)
            }));
        }, 5000);
    }

    // Renderiza o componente
    render() {
        const { 
            statusMessage, peerId, inputPeerId, isPaired, isHost,
            loadingPeerJS, currentTrack, isPlaying, peerConnectionStatus,
            currentPosition, currentVolume, notifications, roomMembers
        } = this.state;
        
        // Estilo em linha para componentes
        const styles = {
            container: {
                padding: "16px",
                fontFamily: "var(--font-family, CircularSp, CircularSp-Arab, CircularSp-Hebr, CircularSp-Cyrl, CircularSp-Grek, CircularSp-Deva, var(--fallback-fonts, sans-serif))",
                color: "var(--spice-text)",
                maxWidth: "1000px",
                margin: "0 auto"
            },
            header: {
                fontSize: "2rem",
                marginBottom: "16px",
                display: "flex",
                alignItems: "center"
            },
            headerIcon: {
                marginRight: "8px",
                color: "var(--spice-button-primary)"
            },
            card: {
                background: "var(--spice-card)",
                borderRadius: "8px",
                padding: "16px",
                marginBottom: "16px",
                boxShadow: "0 4px 12px rgba(0, 0, 0, 0.15)"
            },
            statusConnected: {
                color: "var(--spice-button-primary)",
                fontWeight: "bold"
            },
            statusDisconnected: {
                color: "var(--spice-notification-error)",
                fontWeight: "bold"
            },
            statusLoading: {
                color: "var(--spice-notification-warning)",
                fontWeight: "bold"
            },
            inputGroup: {
                display: "flex",
                marginBottom: "16px"
            },
            input: {
                flex: 1,
                padding: "8px 12px",
                borderRadius: "4px",
                border: "1px solid var(--spice-button-disabled)",
                background: "var(--spice-main)",
                color: "var(--spice-text)",
                fontSize: "14px"
            },
            button: {
                padding: "8px 16px",
                borderRadius: "4px",
                border: "none",
                background: "var(--spice-button-primary)",
                color: "var(--spice-button-primary-foreground)",
                marginLeft: "8px",
                fontWeight: "bold",
                cursor: "pointer"
            },
            secondaryButton: {
                padding: "8px 16px",
                borderRadius: "4px",
                border: "none",
                background: "var(--spice-button)",
                color: "var(--spice-text)",
                marginLeft: "8px",
                cursor: "pointer"
            },
            disconnectButton: {
                padding: "8px 16px",
                borderRadius: "4px",
                border: "none",
                background: "var(--spice-notification-error)",
                color: "white",
                marginLeft: "8px",
                cursor: "pointer"
            },
            infoText: {
                fontSize: "14px",
                marginBottom: "8px"
            },
            peerIdDisplayContainer: {
                display: "flex",
                alignItems: "center",
                marginBottom: "16px",
            },
            peerIdDisplay: {
                fontFamily: "monospace",
                padding: "8px",
                background: "var(--spice-main-elevated)",
                borderRadius: "4px 0 0 4px",
                wordBreak: "break-all",
                flex: 1
            },
            copyButton: {
                padding: "8px 12px",
                background: "var(--spice-button)",
                border: "none",
                borderRadius: "0 4px 4px 0",
                cursor: "pointer",
                fontSize: "16px",
                color: "var(--spice-text)",
                transition: "background-color 0.2s ease"
            },
            trackCard: {
                display: "flex",
                alignItems: "center",
                padding: "16px",
                background: "var(--spice-card)",
                borderRadius: "8px",
                marginBottom: "16px"
            },
            trackImage: {
                width: "64px",
                height: "64px",
                marginRight: "16px",
                borderRadius: "4px"
            },
            trackInfo: {
                flex: 1
            },
            trackTitle: {
                fontSize: "16px",
                fontWeight: "bold",
                marginBottom: "4px"
            },
            trackArtist: {
                fontSize: "14px",
                color: "var(--spice-subtext)"
            },
            playerControls: {
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginTop: "16px"
            },
            playButton: {
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: "var(--spice-text)",
                fontSize: "24px"
            },
            slider: {
                width: "100%",
                margin: "0 16px",
                height: "4px"
            },
            volumeControl: {
                display: "flex",
                alignItems: "center",
                marginTop: "16px"
            },
            volumeSlider: {
                flex: 1,
                marginLeft: "8px"
            },
            membersSection: {
                marginTop: "20px"
            },
            membersList: {
                listStyle: "none",
                padding: 0
            },
            memberItem: {
                padding: "8px 0",
                borderBottom: "1px solid var(--spice-button-disabled)"
            },
            notificationsContainer: {
                position: "fixed",
                bottom: "16px",
                right: "16px",
                maxWidth: "300px",
                zIndex: 1000
            },
            notification: (type) => ({
                padding: "12px",
                marginBottom: "8px",
                borderRadius: "4px",
                backgroundColor: type === "error" ? "var(--spice-notification-error)" :
                                 type === "success" ? "var(--spice-notification-success)" :
                                 type === "chat" ? "var(--spice-button)" :
                                 "var(--spice-notification-information)",
                color: "white",
                boxShadow: "0 2px 8px rgba(0, 0, 0, 0.2)",
                animation: "fadeIn 0.3s ease-out"
            })
        };

        return react.createElement("div", { style: styles.container },
            // Cabeçalho
            react.createElement("div", { style: styles.header },
                react.createElement("span", { style: styles.headerIcon }, "🎵"),
                react.createElement("span", null, "Together")
            ),
            
            // Status da conexão
            react.createElement("div", { style: styles.card },
                react.createElement("div", { style: {
                    ...styles.infoText,
                    ...(peerConnectionStatus === "connected" ? styles.statusConnected :
                        peerConnectionStatus === "disconnected" ? styles.statusDisconnected :
                        styles.statusLoading)
                } }, statusMessage),
                
                !loadingPeerJS && !isPaired && react.createElement("div", null,
                    react.createElement("div", { style: styles.infoText }, "Seu ID de conexão:"),
                    react.createElement("div", { style: styles.peerIdDisplayContainer },
                        react.createElement("div", { style: styles.peerIdDisplay }, peerId),
                        react.createElement("button", {
                            style: styles.copyButton,
                            onClick: () => {
                                navigator.clipboard.writeText(peerId)
                                    .then(() => this.showNotification("ID copiado para a área de transferência!", "success"))
                                    .catch(err => this.showNotification("Erro ao copiar ID", "error"));
                            },
                            title: "Copiar ID"
                        }, "📋")
                    ),
                    react.createElement("div", { style: styles.infoText }, "Conectar a um amigo:"),
                    react.createElement("div", { style: styles.inputGroup },
                        react.createElement("input", {
                            type: "text",
                            style: styles.input,
                            placeholder: "ID do amigo",
                            value: inputPeerId,
                            onChange: (e) => this.setState({ inputPeerId: e.target.value })
                        }),
                        react.createElement("button", {
                            style: styles.button,
                            onClick: this.connectToPeer
                        }, "Conectar")
                    )
                ),
                
                isPaired && react.createElement("button", {
                    style: styles.disconnectButton,
                    onClick: this.disconnectSession
                }, "Desconectar da sessão"),
                
                loadingPeerJS && react.createElement("div", { style: styles.infoText }, "Carregando sistema de comunicação P2P...")
            ),
            
            // Informações da faixa atual
            currentTrack && react.createElement("div", { style: styles.trackCard },
                react.createElement("img", {
                    src: currentTrack.image,
                    style: styles.trackImage,
                    alt: "Album cover"
                }),
                react.createElement("div", { style: styles.trackInfo },
                    react.createElement("div", { style: styles.trackTitle }, currentTrack.name),
                    react.createElement("div", { style: styles.trackArtist }, currentTrack.artist),
                    react.createElement("div", { style: styles.playerControls },
                        react.createElement("button", {
                            style: styles.playButton,
                            onClick: this.playPauseTrack,
                            // Todos podem controlar a reprodução
                            disabled: false
                        }, isPlaying ? "⏸️" : "▶️"),
                        react.createElement("input", {
                            type: "range",
                            min: "0",
                            max: currentTrack.duration,
                            value: currentPosition,
                            style: styles.slider,
                            onChange: (e) => this.seekTrack(parseInt(e.target.value)),
                            // Todos podem controlar a posição
                            disabled: false
                        })
                    ),
                    react.createElement("div", { style: styles.volumeControl },
                        react.createElement("span", null, "Volume (controle individual):"),
                        react.createElement("input", {
                            type: "range",
                            min: "0",
                            max: "100",
                            value: currentVolume,
                            style: styles.volumeSlider,
                            onChange: (e) => this.changeVolume(parseInt(e.target.value)),
                            disabled: false // Todos podem controlar seu próprio volume
                        }),
                        react.createElement("div", {
                            style: { 
                                fontSize: "11px", 
                                color: "var(--spice-subtext)", 
                                marginTop: "4px",
                                fontWeight: "bold"
                            }
                        }, "✓ O volume é 100% individual e nunca será sincronizado")
                    )
                )
            ),
            
            // Membros da sala
            isPaired && react.createElement("div", { style: styles.card },
                react.createElement("h3", null, "Participantes"),
                react.createElement("div", { style: styles.infoText },
                    "Todos têm controle total sobre a música. Ouvindo juntos em sincronia!"
                ),
                react.createElement("ul", { style: styles.membersList },
                    react.createElement("li", { style: styles.memberItem }, 
                        `Você${isHost ? " (Host)" : " (Convidado)"}`
                    ),
                    roomMembers.map(member => 
                        react.createElement("li", { 
                            key: member.peerId,
                            style: styles.memberItem
                        }, `${member.name}${member.isHost ? " (Host)" : " (Convidado)"}`)
                    )
                )
            ),
            
            // Notificações
            react.createElement("div", { style: styles.notificationsContainer },
                notifications.map(notification => 
                    react.createElement("div", {
                        key: notification.id,
                        style: styles.notification(notification.type)
                    }, notification.message)
                )
            ),
            
            // Painel de Debug (visível apenas para desenvolvedores)
            react.createElement("div", {
                style: {
                    padding: "10px",
                    backgroundColor: "#333",
                    color: "#fff",
                    fontSize: "12px",
                    borderRadius: "8px",
                    marginTop: "16px"
                }
            },
                react.createElement("h4", {
                    style: { margin: "0 0 8px 0", fontSize: "14px", fontWeight: "bold" }
                }, "Painel de Debug"),
                react.createElement("p", null, `Papel: ${isPaired ? (isHost ? 'Host (prioridade na faixa inicial)' : 'Convidado (recebe faixa do host)') : 'Desconectado'}`),
                react.createElement("p", null, `Estado de Sincronização: ${isSyncing ? 'SINCRONIZANDO' : 'LIVRE'}`),
                react.createElement("p", null, `Última Sincronização: ${new Date(lastSyncTime).toLocaleTimeString()}`),
                react.createElement("p", null, `Faixa Atual: ${currentTrack ? currentTrack.name : 'Nenhuma'}`),
                react.createElement("p", null, `Artista: ${currentTrack ? currentTrack.artist : 'N/A'}`),
                react.createElement("p", null, `URI: ${currentTrack ? currentTrack.uri : 'N/A'}`),
                react.createElement("p", null, `Posição: ${currentPosition}ms`),
                react.createElement("p", null, `Reproduzindo: ${isPlaying ? 'Sim' : 'Não'}`),
                react.createElement("p", null, `Status da Conexão: ${peerConnectionStatus}`),
                react.createElement("p", null, `Conexões Ativas: ${this.connections.length}`),
                react.createElement("p", null, `Peer ID: ${peerId}`)
            )
        );
    }
}