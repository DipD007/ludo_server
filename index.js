import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Store game rooms
const rooms = new Map();

// Generate random room code
function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Ludo board positions (0-51 for main track, -1 for home, 100+ for home stretch)
const BOARD_SIZE = 52;
const HOME_POSITIONS = {
  red: [1, 2, 3, 4],
  green: [14, 15, 16, 17],
  yellow: [27, 28, 29, 30],
  blue: [40, 41, 42, 43]
};

const START_POSITIONS = {
  red: 1,
  green: 14,
  yellow: 27,
  blue: 40
};

const HOME_STRETCH_START = {
  red: 51,
  green: 12,
  yellow: 25,
  blue: 38
};

const SAFE_POSITIONS = [1, 9, 14, 22, 27, 35, 40, 48]; // Star positions

// Initialize game state
function createGameState() {
  return {
    players: {},
    currentPlayer: 0,
    gameStarted: false,
    diceValue: 1,
    lastRoll: null,
    canRollAgain: false,
    pieces: {
      red: [
        { position: -1, homeIndex: 0, isInHomeStretch: false },
        { position: -1, homeIndex: 1, isInHomeStretch: false },
        { position: -1, homeIndex: 2, isInHomeStretch: false },
        { position: -1, homeIndex: 3, isInHomeStretch: false }
      ],
      green: [
        { position: -1, homeIndex: 0, isInHomeStretch: false },
        { position: -1, homeIndex: 1, isInHomeStretch: false },
        { position: -1, homeIndex: 2, isInHomeStretch: false },
        { position: -1, homeIndex: 3, isInHomeStretch: false }
      ],
      yellow: [
        { position: -1, homeIndex: 0, isInHomeStretch: false },
        { position: -1, homeIndex: 1, isInHomeStretch: false },
        { position: -1, homeIndex: 2, isInHomeStretch: false },
        { position: -1, homeIndex: 3, isInHomeStretch: false }
      ],
      blue: [
        { position: -1, homeIndex: 0, isInHomeStretch: false },
        { position: -1, homeIndex: 1, isInHomeStretch: false },
        { position: -1, homeIndex: 2, isInHomeStretch: false },
        { position: -1, homeIndex: 3, isInHomeStretch: false }
      ]
    }
  };
}

function canMovePiece(piece, diceValue, color) {
  // Can move out of home with 6
  if (piece.position === -1) {
    return diceValue === 6;
  }
  
  // Can move if not in home stretch or if move doesn't exceed home stretch
  if (piece.isInHomeStretch) {
    const homeStretchPosition = piece.position - 100;
    return homeStretchPosition + diceValue <= 6;
  }
  
  return true;
}

function movePiece(piece, diceValue, color) {
  if (piece.position === -1 && diceValue === 6) {
    // Move out of home
    piece.position = START_POSITIONS[color];
    return { moved: true, captured: null };
  }
  
  if (piece.position === -1) {
    return { moved: false, captured: null };
  }
  
  let newPosition;
  let captured = null;
  
  if (piece.isInHomeStretch) {
    // Moving in home stretch
    const homeStretchPosition = piece.position - 100;
    if (homeStretchPosition + diceValue <= 6) {
      piece.position = 100 + homeStretchPosition + diceValue;
      return { moved: true, captured: null };
    }
    return { moved: false, captured: null };
  }
  
  newPosition = (piece.position + diceValue) % BOARD_SIZE;
  
  // Check if entering home stretch
  const homeStretchStart = HOME_STRETCH_START[color];
  if (piece.position <= homeStretchStart && newPosition > homeStretchStart) {
    // Enter home stretch
    const stepsIntoHomeStretch = newPosition - homeStretchStart;
    if (stepsIntoHomeStretch <= 6) {
      piece.position = 100 + stepsIntoHomeStretch;
      piece.isInHomeStretch = true;
      return { moved: true, captured: null };
    }
  }
  
  piece.position = newPosition;
  return { moved: true, captured: captured };
}

function checkCapture(gameState, movedPiece, color, newPosition) {
  // Don't capture on safe positions
  if (SAFE_POSITIONS.includes(newPosition)) {
    return null;
  }
  
  // Check all other players' pieces
  for (const [otherColor, pieces] of Object.entries(gameState.pieces)) {
    if (otherColor === color) continue;
    
    for (let i = 0; i < pieces.length; i++) {
      const otherPiece = pieces[i];
      if (otherPiece.position === newPosition && !otherPiece.isInHomeStretch) {
        // Capture the piece
        otherPiece.position = -1;
        otherPiece.isInHomeStretch = false;
        return { color: otherColor, pieceIndex: i };
      }
    }
  }
  
  return null;
}

function getMovablePieces(gameState, color, diceValue) {
  return gameState.pieces[color]
    .map((piece, index) => ({ piece, index }))
    .filter(({ piece }) => canMovePiece(piece, diceValue, color));
}

function hasWon(gameState, color) {
  return gameState.pieces[color].every(piece => 
    piece.isInHomeStretch && piece.position === 106
  );
}

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Create room
  socket.on('create-room', (playerName) => {
    const roomCode = generateRoomCode();
    const gameState = createGameState();
    
    gameState.players[socket.id] = {
      name: playerName,
      color: 'red',
      isHost: true
    };

    rooms.set(roomCode, {
      ...gameState,
      roomCode,
      playerCount: 1
    });

    socket.join(roomCode);
    socket.emit('room-created', { roomCode, gameState: rooms.get(roomCode) });
    
    console.log(`Room ${roomCode} created by ${playerName}`);
  });

  // Join room
  socket.on('join-room', ({ roomCode, playerName }) => {
    const room = rooms.get(roomCode);
    
    if (!room) {
      socket.emit('room-error', 'Room not found');
      return;
    }

    if (room.playerCount >= 4) {
      socket.emit('room-error', 'Room is full');
      return;
    }

    if (room.gameStarted) {
      socket.emit('room-error', 'Game already started');
      return;
    }

    const colors = ['red', 'green', 'yellow', 'blue'];
    const usedColors = Object.values(room.players).map(p => p.color);
    const availableColor = colors.find(color => !usedColors.includes(color));

    room.players[socket.id] = {
      name: playerName,
      color: availableColor,
      isHost: false
    };

    room.playerCount++;
    socket.join(roomCode);
    
    // Send game state to the joining player
    socket.emit('joined-room', { gameState: room });
    
    // Notify all players about the new player
    io.to(roomCode).emit('player-joined', {
      player: room.players[socket.id],
      gameState: room
    });

    console.log(`${playerName} joined room ${roomCode} as ${availableColor}`);
  });

  // Start game
  socket.on('start-game', (roomCode) => {
    const room = rooms.get(roomCode);
    
    if (!room || !room.players[socket.id]?.isHost) {
      socket.emit('game-error', 'Not authorized to start game');
      return;
    }

    if (room.playerCount < 2) {
      socket.emit('game-error', 'Need at least 2 players to start');
      return;
    }

    room.gameStarted = true;
    io.to(roomCode).emit('game-started', room);
    
    console.log(`Game started in room ${roomCode}`);
  });

  // Roll dice
  socket.on('roll-dice', (roomCode) => {
    const room = rooms.get(roomCode);
    
    if (!room || !room.gameStarted) {
      return;
    }

    const playerIds = Object.keys(room.players);
    const currentPlayerId = playerIds[room.currentPlayer];
    
    if (socket.id !== currentPlayerId) {
      socket.emit('game-error', 'Not your turn');
      return;
    }

    const diceValue = Math.floor(Math.random() * 6) + 1;
    room.diceValue = diceValue;
    room.lastRoll = diceValue;

    const playerColor = room.players[socket.id].color;
    const movablePieces = getMovablePieces(room, playerColor, diceValue);

    // Check if player can roll again (got 6 or captured a piece)
    room.canRollAgain = diceValue === 6;

    io.to(roomCode).emit('dice-rolled', {
      diceValue,
      currentPlayer: room.currentPlayer,
      gameState: room,
      movablePieces: movablePieces.map(mp => mp.index),
      canRollAgain: room.canRollAgain
    });

    // If no movable pieces and didn't roll 6, switch turn
    if (movablePieces.length === 0 && diceValue !== 6) {
      room.currentPlayer = (room.currentPlayer + 1) % room.playerCount;
      room.canRollAgain = false;
      
      io.to(roomCode).emit('turn-switched', {
        currentPlayer: room.currentPlayer,
        gameState: room
      });
    }

    console.log(`Dice rolled: ${diceValue} in room ${roomCode}`);
  });

  // Move piece
  socket.on('move-piece', ({ roomCode, pieceIndex }) => {
    const room = rooms.get(roomCode);
    
    if (!room || !room.gameStarted) {
      return;
    }

    const playerIds = Object.keys(room.players);
    const currentPlayerId = playerIds[room.currentPlayer];
    
    if (socket.id !== currentPlayerId) {
      return;
    }

    const playerColor = room.players[socket.id].color;
    const piece = room.pieces[playerColor][pieceIndex];
    const diceValue = room.diceValue;

    if (!canMovePiece(piece, diceValue, playerColor)) {
      socket.emit('game-error', 'Invalid move');
      return;
    }

    const oldPosition = piece.position;
    const moveResult = movePiece(piece, diceValue, playerColor);

    if (!moveResult.moved) {
      socket.emit('game-error', 'Cannot move this piece');
      return;
    }

    // Check for capture
    let captured = null;
    if (piece.position !== -1 && !piece.isInHomeStretch) {
      captured = checkCapture(room, piece, playerColor, piece.position);
    }

    // Check for win
    const hasPlayerWon = hasWon(room, playerColor);

    // Determine if player gets another turn
    let anotherTurn = room.lastRoll === 6 || captured !== null;

    if (!anotherTurn || hasPlayerWon) {
      room.currentPlayer = (room.currentPlayer + 1) % room.playerCount;
      room.canRollAgain = false;
    }

    io.to(roomCode).emit('piece-moved', {
      playerColor,
      pieceIndex,
      oldPosition,
      newPosition: piece.position,
      captured,
      gameState: room,
      hasWon: hasPlayerWon,
      anotherTurn
    });

    if (hasPlayerWon) {
      io.to(roomCode).emit('game-won', {
        winner: playerColor,
        playerName: room.players[socket.id].name
      });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Remove player from all rooms
    for (const [roomCode, room] of rooms.entries()) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        room.playerCount--;
        
        if (room.playerCount === 0) {
          rooms.delete(roomCode);
          console.log(`Room ${roomCode} deleted - no players left`);
        } else {
          // If host left, make another player host
          if (room.players[socket.id]?.isHost) {
            const remainingPlayers = Object.keys(room.players);
            if (remainingPlayers.length > 0) {
              room.players[remainingPlayers[0]].isHost = true;
            }
          }
          
          io.to(roomCode).emit('player-left', {
            playerId: socket.id,
            gameState: room
          });
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});