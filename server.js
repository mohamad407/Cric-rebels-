const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('bcryptjs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { connectDB, User, Match } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// JWT Secret
const JWT_SECRET = process.env.JWT_SECRET || 'cric-rebels-secret-key-2024';

// Auth Middleware
const authMiddleware = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.userId = decoded.userId;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token' });
    }
};

// ===== AUTH ROUTES =====

// Signup
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        
        // Check if user exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ error: 'Email already registered' });
        }
        
        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // Create user
        const user = new User({
            name,
            email,
            password: hashedPassword
        });
        
        await user.save();
        
        res.status(201).json({ message: 'User created successfully' });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ error: 'Failed to create user' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Find user
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Check password
        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Generate token
        const token = jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '7d' });
        
        res.json({
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Failed to login' });
    }
});

// ===== MATCH ROUTES =====

// Create Match
app.post('/api/matches', authMiddleware, async (req, res) => {
    try {
        const { name, totalOvers, teamA, teamB } = req.body;
        
        // Validate overs
        if (totalOvers < 1 || totalOvers > 90) {
            return res.status(400).json({ error: 'Overs must be between 1 and 90' });
        }
        
        // Validate players
        if (teamA.players.length < 4 || teamA.players.length > 11) {
            return res.status(400).json({ error: 'Team A must have 4-11 players' });
        }
        
        if (teamB.players.length < 4 || teamB.players.length > 11) {
            return res.status(400).json({ error: 'Team B must have 4-11 players' });
        }
        
        // Generate unique match code
        const generateCode = () => {
            const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
            let code = '';
            for (let i = 0; i < 6; i++) {
                code += chars.charAt(Math.floor(Math.random() * chars.length));
            }
            return code;
        };
        
        let matchCode = generateCode();
        let existingMatch = await Match.findOne({ code: matchCode });
        
        // Ensure unique code
        while (existingMatch) {
            matchCode = generateCode();
            existingMatch = await Match.findOne({ code: matchCode });
        }
        
        // Create match
        const match = new Match({
            code: matchCode,
            name,
            totalOvers,
            creator: req.userId,
            teamA: {
                name: teamA.name,
                players: teamA.players.map((name, idx) => ({
                    _id: `teamA_player_${idx}`,
                    name
                }))
            },
            teamB: {
                name: teamB.name,
                players: teamB.players.map((name, idx) => ({
                    _id: `teamB_player_${idx}`,
                    name
                }))
            },
            innings: [{
                battingTeam: 'teamA',
                totalRuns: 0,
                wickets: 0,
                overs: 0,
                balls: 0,
                thisOver: [],
                batsmen: [],
                bowlers: []
            }],
            currentInnings: 0,
            status: 'live'
        });
        
        await match.save();
        
        res.status(201).json({
            message: 'Match created successfully',
            match
        });
    } catch (error) {
        console.error('Create match error:', error);
        res.status(500).json({ error: 'Failed to create match' });
    }
});

// Get Match
app.get('/api/matches/:code', authMiddleware, async (req, res) => {
    try {
        const match = await Match.findOne({ code: req.params.code });
        
        if (!match) {
            return res.status(404).json({ error: 'Match not found' });
        }
        
        const isCreator = match.creator.toString() === req.userId;
        
        res.json({
            match,
            isCreator
        });
    } catch (error) {
        console.error('Get match error:', error);
        res.status(500).json({ error: 'Failed to get match' });
    }
});

// ===== SOCKET.IO =====

const matchRooms = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);
    
    // Join match room
    socket.on('joinMatch', async (matchCode) => {
        try {
            const match = await Match.findOne({ code: matchCode });
            if (!match) {
                socket.emit('error', { message: 'Match not found' });
                return;
            }
            
            socket.join(matchCode);
            
            if (!matchRooms.has(matchCode)) {
                matchRooms.set(matchCode, new Set());
            }
            matchRooms.get(matchCode).add(socket.id);
            
            // Send current match state
            socket.emit('scoreUpdate', match);
            
            console.log(`User joined match: ${matchCode}`);
        } catch (error) {
            console.error('Join match error:', error);
        }
    });
    
    // Leave match room
    socket.on('leaveMatch', (matchCode) => {
        socket.leave(matchCode);
        
        if (matchRooms.has(matchCode)) {
            matchRooms.get(matchCode).delete(socket.id);
        }
        
        console.log(`User left match: ${matchCode}`);
    });
    
    // Score action
    socket.on('scoreAction', async (data) => {
        try {
            const { matchCode, type, ...actionData } = data;
            
            const match = await Match.findOne({ code: matchCode });
            if (!match) {
                return;
            }
            
            const innings = match.innings[match.currentInnings];
            
            // Process action
            switch (type) {
                case 'runs':
                    processRuns(innings, actionData.value, match);
                    break;
                case 'wicket':
                    processWicket(innings, actionData, match);
                    break;
                case 'noBall':
                    processNoBall(innings, match);
                    break;
                case 'wide':
                    processWide(innings, match);
                    break;
                case 'freeHit':
                    match.freeHit = true;
                    break;
                case 'undo':
                    // Undo last action (simplified)
                    break;
            }
            
            // Check for over completion
            if (innings.balls >= 6 && innings.balls % 6 === 0) {
                innings.thisOver = [];
                // Rotate strike at end of over
                if (innings.striker && innings.nonStriker) {
                    const temp = innings.striker;
                    innings.striker = innings.nonStriker;
                    innings.nonStriker = temp;
                }
            }
            
            // Check for innings completion
            if (innings.wickets >= 10 || innings.overs >= match.totalOvers) {
                if (match.currentInnings === 0) {
                    // First innings complete - signal for second innings setup
                    match.status = 'innings-break';
                } else {
                    match.status = 'completed';
                }
            }
            
            // Calculate overs
            innings.overs = Math.floor(innings.balls / 6) + (innings.balls % 6) / 10;
            
            await match.save();
            
            // Broadcast to all users in room
            io.to(matchCode).emit('scoreUpdate', match);
            
        } catch (error) {
            console.error('Score action error:', error);
        }
    });
    
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        // Clean up rooms
        matchRooms.forEach((sockets, matchCode) => {
            sockets.delete(socket.id);
        });
    });
});

// Helper functions for score processing

function processRuns(innings, runs, match) {
    innings.totalRuns += runs;
    innings.balls++;
    
    // Add to this over
    innings.thisOver.push(runs.toString());
    
    // Update striker
    if (innings.striker) {
        innings.striker.runs += runs;
        innings.striker.balls++;
        
        if (runs === 4) innings.striker.fours++;
        if (runs === 6) innings.striker.sixes++;
    }
    
    // Update bowler
    if (innings.bowler) {
        innings.bowler.runs += runs;
        innings.bowler.balls++;
    }
    
    // Rotate strike for odd runs
    if (runs % 2 === 1 && innings.striker && innings.nonStriker) {
        const temp = innings.striker;
        innings.striker = innings.nonStriker;
        innings.nonStriker = temp;
    }
    
    // Clear free hit
    match.freeHit = false;
}

function processWicket(innings, data, match) {
    // Only count wicket if not free hit
    if (!match.freeHit) {
        innings.wickets++;
        innings.thisOver.push('W');
        innings.balls++;
        
        // Update bowler wickets
        if (innings.bowler) {
            innings.bowler.wickets++;
            innings.bowler.balls++;
        }
        
        // Mark batsman as out
        if (!innings.outBatsmen) innings.outBatsmen = [];
        innings.outBatsmen.push(data.outBatsman);
    }
    
    // Set new batsman
    const battingTeam = innings.battingTeam === 'teamA' ? match.teamA : match.teamB;
    const newBatsman = battingTeam.players.find(p => p._id === data.nextBatsman);
    
    if (newBatsman) {
        if (data.outBatsman === innings.striker?.id) {
            innings.striker = {
                id: newBatsman._id,
                name: newBatsman.name,
                runs: 0,
                balls: 0,
                fours: 0,
                sixes: 0
            };
        } else {
            innings.nonStriker = {
                id: newBatsman._id,
                name: newBatsman.name,
                runs: 0,
                balls: 0,
                fours: 0,
                sixes: 0
            };
        }
    }
    
    match.freeHit = false;
}

function processNoBall(innings, match) {
    innings.totalRuns++;
    innings.thisOver.push('NB');
    
    // Update bowler
    if (innings.bowler) {
        innings.bowler.runs++;
    }
    
    // Set free hit
    match.freeHit = true;
}

function processWide(innings, match) {
    innings.totalRuns++;
    innings.thisOver.push('WD');
    
    // Update bowler
    if (innings.bowler) {
        innings.bowler.runs++;
    }
}

// Start innings (for second innings setup)
io.on('connection', (socket) => {
    socket.on('startSecondInnings', async (data) => {
        try {
            const { matchCode, openingBatsman1, openingBatsman2, openingBowler } = data;
            
            const match = await Match.findOne({ code: matchCode });
            if (!match) return;
            
            // Initialize second innings
            match.currentInnings = 1;
            match.innings.push({
                battingTeam: 'teamB',
                totalRuns: 0,
                wickets: 0,
                overs: 0,
                balls: 0,
                thisOver: [],
                striker: null,
                nonStriker: null,
                bowler: null
            });
            
            // Set opening batsmen and bowler
            const newInnings = match.innings[1];
            const battingTeam = match.teamB;
            const bowlingTeam = match.teamA;
            
            const batsman1 = battingTeam.players.find(p => p._id === openingBatsman1);
            const batsman2 = battingTeam.players.find(p => p._id === openingBatsman2);
            const bowler = bowlingTeam.players.find(p => p._id === openingBowler);
            
            if (batsman1) {
                newInnings.striker = {
                    id: batsman1._id,
                    name: batsman1.name,
                    runs: 0,
                    balls: 0,
                    fours: 0,
                    sixes: 0
                };
            }
            
            if (batsman2) {
                newInnings.nonStriker = {
                    id: batsman2._id,
                    name: batsman2.name,
                    runs: 0,
                    balls: 0,
                    fours: 0,
                    sixes: 0
                };
            }
            
            if (bowler) {
                newInnings.bowler = {
                    id: bowler._id,
                    name: bowler.name,
                    overs: 0,
                    balls: 0,
                    runs: 0,
                    wickets: 0,
                    maidens: 0
                };
            }
            
            match.status = 'live';
            await match.save();
            
            io.to(matchCode).emit('scoreUpdate', match);
        } catch (error) {
            console.error('Start second innings error:', error);
        }
    });
});

// Initialize match with opening players
io.on('connection', (socket) => {
    socket.on('initializeMatch', async (data) => {
        try {
            const { matchCode, openingBatsman1, openingBatsman2, openingBowler } = data;
            
            const match = await Match.findOne({ code: matchCode });
            if (!match) return;
            
            const innings = match.innings[0];
            const battingTeam = match.teamA;
            const bowlingTeam = match.teamB;
            
            const batsman1 = battingTeam.players.find(p => p._id === openingBatsman1);
            const batsman2 = battingTeam.players.find(p => p._id === openingBatsman2);
            const bowler = bowlingTeam.players.find(p => p._id === openingBowler);
            
            if (batsman1) {
                innings.striker = {
                    id: batsman1._id,
                    name: batsman1.name,
                    runs: 0,
                    balls: 0,
                    fours: 0,
                    sixes: 0
                };
            }
            
            if (batsman2) {
                innings.nonStriker = {
                    id: batsman2._id,
                    name: batsman2.name,
                    runs: 0,
                    balls: 0,
                    fours: 0,
                    sixes: 0
                };
            }
            
            if (bowler) {
                innings.bowler = {
                    id: bowler._id,
                    name: bowler.name,
                    overs: 0,
                    balls: 0,
                    runs: 0,
                    wickets: 0,
                    maidens: 0
                };
            }
            
            await match.save();
            
            io.to(matchCode).emit('scoreUpdate', match);
        } catch (error) {
            console.error('Initialize match error:', error);
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;

connectDB().then(() => {
    server.listen(PORT, () => {
        console.log(`Cric Rebels server running on port ${PORT}`);
    });
}).catch(err => {
    console.error('Failed to connect to database:', err);
    process.exit(1);
});
