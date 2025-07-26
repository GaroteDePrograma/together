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

// Nossa classe principal
class TogetherApp extends react.Component {
    constructor(props) {
        super(props);
        this.state = {
            isHost: false,
            isPaired: false,
            peerId: "",
            remotePeerId: "",
            connections: [],
            statusMessage: "Aguardando conexão...",
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
            // Carrega a biblioteca PeerJS dinamicamente
            const Peer = await loadPeerJS();
            this.setState({ loadingPeerJS: false });
            
            // Gera ID randomico para o peer
            const randomPeerId = Math.random().toString(36).substring(2, 10);
            
            // Inicializa o peer
            this.peer = new Peer(randomPeerId);
            
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

            // Configuração dos event listeners do Spotify
            this.setupSpotifyListeners();

        } catch (error) {
            console.error("Failed to load PeerJS:", error);
            this.setState({ 
                statusMessage: "Falha ao carregar biblioteca P2P. Tente recarregar.",
                peerConnectionStatus: "error"
            });
        }
    }

    componentWillUnmount() {
        // Limpa os intervalos e conexões
        if (this.currentTrackInterval) clearInterval(this.currentTrackInterval);
        if (this.playerStateInterval) clearInterval(this.playerStateInterval);
        
        // Fecha todas as conexões P2P
        this.connections.forEach(conn => conn.close());
        
        // Fecha o peer
        if (this.peer) this.peer.destroy();
        
        // Remove os listeners do Spotify
        Spicetify.Player.removeEventListener("songchange", this.handleSongChange);
        Spicetify.Player.removeEventListener("onplaypause", this.handlePlayPause);
        Spicetify.Player.removeEventListener("onprogress", this.handleProgress);
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
    updateCurrentTrack = () => {
        const currentTrack = Spicetify.Player.data.track;
        if (!currentTrack) return;
        
        const trackInfo = {
            name: currentTrack.metadata.title,
            artist: currentTrack.metadata.artist_name,
            album: currentTrack.metadata.album_title,
            duration: currentTrack.duration,
            uri: currentTrack.uri,
            image: currentTrack.metadata.image_url,
            contextUri: Spicetify.Player.data.context_uri || null,
            contextType: Spicetify.Player.data.context_metadata?.context_type || null
        };
        
        // Compara se a música mudou usando o URI
        const trackChanged = !this.state.currentTrack || 
                            this.state.currentTrack.uri !== trackInfo.uri;
        
        if (trackChanged) {
            console.log("Track changed to:", trackInfo.name);
            this.setState({ currentTrack: trackInfo });
            
            // Se for host, envia a atualização de faixa com alta prioridade
            if (this.state.isHost && this.state.isPaired) {
                this.broadcastToAll({
                    type: "track_change",
                    data: trackInfo,
                    position: Spicetify.Player.getProgress(),
                    isPlaying: Spicetify.Player.isPlaying()
                });
                
                // Adiciona uma notificação para o host também
                this.showNotification(`Alterou para: ${trackInfo.name} - ${trackInfo.artist}`, "info");
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
                currentVolume // O volume é mantido localmente apenas
            });
            
            // Se for host, envia o estado atualizado (sem incluir o volume)
            if (this.state.isHost && this.state.isPaired) {
                this.broadcastToAll({
                    type: "player_state",
                    data: {
                        isPlaying,
                        position: currentPosition
                        // Volume não é sincronizado
                    }
                });
            }
        }
    };

    // Handlers para eventos do Spotify
    handleSongChange = () => {
        this.updateCurrentTrack();
    };

    handlePlayPause = () => {
        const isPlaying = Spicetify.Player.isPlaying();
        this.setState({ isPlaying });
        
        if (this.state.isHost && this.state.isPaired) {
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
        
        // Atualiza o estado
        this.setState(prevState => {
            const newRoomMembers = [...prevState.roomMembers, {
                peerId: conn.peer,
                name: conn.metadata?.name || "Usuário",
                isHost: !isIncoming
            }];
            
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

        // Se for host, envia o estado atual
        if (!isIncoming) {
            // Aguarda um momento para garantir que a conexão está estabelecida
            setTimeout(() => {
                this.showNotification("Conectado como convidado. O host controla a música.", "success");
            }, 1000);
        } else {
            // Como host, envia o estado atual
            const currentTrack = this.state.currentTrack;
            const isPlaying = Spicetify.Player.isPlaying();
            const position = Spicetify.Player.getProgress();
            
            setTimeout(() => {
                conn.send({
                    type: "initial_state",
                    data: {
                        track: currentTrack,
                        isPlaying: isPlaying,
                        position: position,
                        hostId: this.state.peerId
                    }
                });
                
                this.showNotification("Alguém se conectou a você. Você é o host.", "success");
            }, 1000);
        }
    }

    // Manipula o fechamento de uma conexão
    handleConnectionClose(closedConn) {
        // Remove da lista de conexões
        this.connections = this.connections.filter(conn => conn !== closedConn);
        
        // Atualiza a lista de membros
        this.setState(prevState => {
            const newRoomMembers = prevState.roomMembers.filter(
                member => member.peerId !== closedConn.peer
            );
            
            return {
                roomMembers: newRoomMembers,
                isPaired: this.connections.length > 0,
                statusMessage: this.connections.length === 0 
                    ? "A conexão foi encerrada. Aguardando nova conexão..."
                    : `Um usuário desconectou. Ainda conectado com ${this.connections.length} usuário(s).`,
                peerConnectionStatus: this.connections.length > 0 ? "connected" : "disconnected"
            };
        });
        
        this.showNotification("Um usuário se desconectou da sessão", "info");
    }

    // Manipula dados recebidos
    handleIncomingData(data, conn) {
        console.log("Received data:", data);
        
        switch(data.type) {
            case "track_change":
                this.handleTrackChange(data.data, data.position, data.isPlaying);
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
                
            case "volume_change":
                this.handleRemoteVolumeChange(data.data.volume);
                break;
                
            case "chat_message":
                this.handleChatMessage(data.data, conn.peer);
                break;
                
            default:
                console.log("Unknown data type:", data.type);
        }
    }

    // Manipula a mudança de faixa recebida
    handleTrackChange(trackInfo, position, isPlaying) {
        if (!this.state.isHost) {
            // Somente clientes não-host respondem a mudanças de faixa
            
            // Verifica se estamos tocando a mesma música
            const currentUri = this.state.currentTrack?.uri;
            if (currentUri !== trackInfo.uri) {
                // Se a música for diferente, força a mudança
                console.log("Recebida mudança de faixa do host:", trackInfo.name);
                
                // Reproduz a faixa com a posição e estado atualizados
                this.playTrack(trackInfo.uri, position, isPlaying);
                
                // Atualiza o estado local
                this.setState({ 
                    currentTrack: trackInfo, 
                    currentPosition: position,
                    isPlaying: isPlaying 
                });
                
                // Mostra notificação
                this.showNotification(`O host mudou para: ${trackInfo.name} - ${trackInfo.artist}`, "info");
            } else if (Math.abs(this.state.currentPosition - position) > 3000) {
                // Se for a mesma música mas a posição divergiu muito, sincroniza
                Spicetify.Player.seek(position);
                this.showNotification(`Sincronizado posição na faixa`, "info");
            }
        }
    }

    // Manipula o comando de play/pause recebido
    handleRemotePlayPause(isPlaying) {
        if (!this.state.isHost) {
            if (isPlaying) {
                Spicetify.Player.play();
            } else {
                Spicetify.Player.pause();
            }
        }
    }

    // Manipula o comando de seek recebido
    handleRemoteSeek(position) {
        if (!this.state.isHost) {
            Spicetify.Player.seek(position);
        }
    }

    // Manipula o estado inicial recebido do host
    handleInitialState(data) {
        if (!this.state.isHost) {
            if (data.track && data.track.uri) {
                this.playTrack(data.track.uri, data.position, data.isPlaying);
                this.showNotification(`Sincronizando com: ${data.track.name} - ${data.track.artist}`, "info");
            }
        }
    }

    // Manipula o estado do player recebido
    handleRemotePlayerState(state) {
        if (!this.state.isHost) {
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
    }

    // Volume não é mais sincronizado entre os usuários
    handleRemoteVolumeChange(volume) {
        // Função mantida para compatibilidade, mas não faz nada
    }

    // Manipula mensagens de chat
    handleChatMessage(messageData, senderId) {
        const sender = this.state.roomMembers.find(m => m.peerId === senderId) || 
                      { name: "Usuário", peerId: senderId };
        
        this.showNotification(`${sender.name}: ${messageData.message}`, "chat");
    }

    // Reproduz uma faixa específica
    playTrack(uri, position = 0, shouldPlay = true) {
        // Registra o que está acontecendo para debug
        console.log(`Tocando faixa: ${uri}, posição: ${position}ms, play: ${shouldPlay}`);
        
        // Reproduz a URI com mais parâmetros para melhor controle
        Spicetify.Player.playUri(uri, {}, { 
            seek: position,
            skipTo: { uri: uri }
        });
        
        // Verifica se devemos pausar a reprodução após carregar a música
        if (!shouldPlay) {
            // Aguarda um pouco para garantir que a música foi carregada antes de pausar
            setTimeout(() => {
                Spicetify.Player.pause();
            }, 500);
        } else {
            // Se deveria estar tocando mas ainda não está, força o play
            setTimeout(() => {
                if (!Spicetify.Player.isPlaying()) {
                    Spicetify.Player.play();
                }
            }, 500);
        }
        
        // Depois que a música carregou, verifica se a posição está correta
        setTimeout(() => {
            const currentPosition = Spicetify.Player.getProgress();
            if (Math.abs(currentPosition - position) > 2000) {
                Spicetify.Player.seek(position);
            }
        }, 1000);
    }

    // Enviar uma mensagem para todos os peers conectados
    broadcastToAll(message) {
        this.connections.forEach(conn => {
            if (conn.open) {
                conn.send(message);
            }
        });
    }

    // Ações de controle de mídia que podem ser iniciadas pelo host
    playPauseTrack = () => {
        const isPlaying = !this.state.isPlaying;
        
        if (isPlaying) {
            Spicetify.Player.play();
        } else {
            Spicetify.Player.pause();
        }
        
        this.setState({ isPlaying });
        
        // Se for host, envia o comando
        if (this.state.isHost && this.state.isPaired) {
            this.broadcastToAll({
                type: "play_pause",
                data: { isPlaying }
            });
        }
    };

    seekTrack = (position) => {
        Spicetify.Player.seek(position);
        
        // Se for host, envia o comando
        if (this.state.isHost && this.state.isPaired) {
            this.broadcastToAll({
                type: "seek",
                data: { position }
            });
        }
    };

    changeVolume = (volume) => {
        Spicetify.Player.setVolume(volume / 100);
        this.setState({ currentVolume: volume });
        
        // Volume não é mais sincronizado entre os usuários
        // Cada usuário controla seu próprio volume independentemente
    };

    // Desconecta da sessão atual
    disconnectSession = () => {
        // Fecha todas as conexões
        this.connections.forEach(conn => conn.close());
        this.connections = [];
        
        // Reinicia o estado
        this.setState({
            isPaired: false,
            isHost: false,
            remotePeerId: "",
            roomMembers: [],
            statusMessage: "Desconectado. Inicie uma nova sessão.",
            peerConnectionStatus: "disconnected"
        });
        
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
                            disabled: !isHost && isPaired
                        }, isPlaying ? "⏸️" : "▶️"),
                        react.createElement("input", {
                            type: "range",
                            min: "0",
                            max: currentTrack.duration,
                            value: currentPosition,
                            style: styles.slider,
                            onChange: (e) => this.seekTrack(parseInt(e.target.value)),
                            disabled: !isHost && isPaired
                        })
                    ),
                    react.createElement("div", { style: styles.volumeControl },
                        react.createElement("span", null, "Volume:"),
                        react.createElement("input", {
                            type: "range",
                            min: "0",
                            max: "100",
                            value: currentVolume,
                            style: styles.volumeSlider,
                            onChange: (e) => this.changeVolume(parseInt(e.target.value)),
                            disabled: !isHost && isPaired
                        })
                    )
                )
            ),
            
            // Membros da sala
            isPaired && react.createElement("div", { style: styles.card },
                react.createElement("h3", null, "Participantes"),
                react.createElement("div", { style: styles.infoText },
                    isHost ? "Você é o host da sessão" : "Você é um convidado nesta sessão"
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
            )
        );
    }
}