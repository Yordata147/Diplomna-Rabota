const express = require('express');
const mysql = require('mysql');
const bcrypt = require('bcryptjs');
const bodyParser = require('body-parser');
const session = require('express-session');
const cors = require('cors');
const path = require('path');

const app = express();
const port = 3000;


// Serve static files
app.use(express.static('public'));

// Use CORS to allow communication from your frontend
app.use(cors({
    origin: 'http://127.0.0.1:5500', // Your frontend origin
    methods: ['GET', 'POST'],
    credentials: true, // Allow cookies
}));

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const MySQLStore = require('express-mysql-session')(session);

// MySQL Database Connection
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '',
    database: 'shared_driving',
});

db.connect(err => {
    if (err) {
        console.error('Database connection failed:', err);
        throw err;
    }
    console.log('Connected to MySQL');
    // Clear all sessions from the database on server restart
    db.query('DELETE FROM sessions', err => {
        if (err) {
            console.log('Failed to clear sessions:', err);
        } else {
            console.log('All sessions cleared.');
        }
    });
});

app.use(session({
    secret: 'ccb7cbc8bdd24ae754a16d33a5ea007720be4faa03ecf6fa28f4be5567297448b8baf7a992e98653927414b5ccd5fc30719d889c66d6fd494dca0e5bd8f1dc1a',
    resave: false,
    saveUninitialized: true,
    store: new MySQLStore({
        host: 'localhost',
        user: 'root',
        password: '',
        database: 'shared_driving',
        checkExpirationInterval: 900000,
        expiration: 86400000
    }),
    cookie: {
        secure: false, // Set to true only if you are using HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
        //sameSite: 'None'
    }
}));


// Routes
app.post('/register', async (req, res) => {
    const { username, email, password } = req.body;

    try {
        const [existingUser] = await new Promise((resolve, reject) => {
            db.query(
                'SELECT * FROM users WHERE username = ? OR email_phone = ?',
                [username, email],
                (err, result) => (err ? reject(err) : resolve(result))
            );
        });

        if (existingUser) {
            return res.json({
                error: existingUser.username === username
                    ? 'Username already taken'
                    : 'Email or phone number already taken',
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        await new Promise((resolve, reject) => {
            db.query(
                'INSERT INTO users (email_phone, username, password) VALUES (?, ?, ?)',
                [email, username, hashedPassword],
                err => (err ? reject(err) : resolve())
            );
        });

        req.session.username = username;
        res.json({ success: 'Registration successful! Redirecting...' });
    } catch (err) {
        console.error('Error in /register:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ?', [username], (err, results) => {
        if (err) return res.status(500).json({ error: 'Internal server error' });
        if (results.length === 0) return res.status(404).json({ error: 'User not found' });

        const user = results[0];
        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (err) return res.status(500).json({ error: 'Error checking password' });
            if (!isMatch) return res.status(401).json({ error: 'Incorrect password' });

            req.session.username = user.username;
            res.json({ success: true, message: 'Logged in successfully', username: user.username });
        });
    });
});


app.get('/check-session', (req, res) => {
    console.log('Session data in check-session:', req.session); // Debug session data
    if (req.session && req.session.username) {
        return res.json({ loggedIn: true, username: req.session.username });
    }
    return res.json({ loggedIn: false });
});


app.post('/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Session destruction failed:', err);
            return res.status(500).json({ error: 'Logout failed' });
        }
        res.clearCookie('connect.sid', { path: '/' }); // Adjust the cookie name if different
        res.json({ success: 'Logged out successfully' });
    });
});

app.post('/createRoom', (req, res) => {
    const createdBy = req.session.username;

    if (!createdBy) {
        return res.status(401).json({ success: false, error: 'You must be logged in to create a room.' });
    }

    const { roomName, startPoint, endPoint, privacy } = req.body;
    const roomId = Math.random().toString(36).substring(2, 15); // Generate a unique ID
    const createdAt = new Date();

    db.query(
        'INSERT INTO rooms (room_id, room_name, start_point, end_point, privacy, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [roomId, roomName, startPoint, endPoint, privacy, createdBy, createdAt],
        (err) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).json({ success: false, error: 'Internal server error.' });
            }

            const roomLink = `http://localhost:3000/room.html?roomId=${roomId}&roomName=${roomName}`;
            res.json({ success: true, message: 'Room created successfully!', roomLink });
        }
    );
});

// Server-side: Node.js with Express
app.get('/api/get-room-details', async (req, res) => {
    const roomId = req.query.roomId;
    if (!roomId) {
        console.error("Room ID not provided");
        return res.status(400).json({ error: 'Room ID is required' });
    }

    db.query('SELECT start_point AS startPoint, end_point AS endPoint FROM rooms WHERE room_id = ?', [roomId], (err, results) => {
        if (err) {
            console.error('Database error:', err);
            return res.status(500).json({ error: 'Internal server error', details: err.sqlMessage });
        }
        if (results.length > 0) {
            res.json(results[0]);
        } else {
            res.status(404).json({ error: 'Room not found' });
        }
    });
});

app.get('/room/:roomId', (req, res) => {
    if (!req.session.username) {
        // If the user is not logged in, redirect to login page
        res.redirect('/login.html');
    } else {
        // If logged in, serve the room page
        const roomId = req.params.roomId;
        db.query('SELECT * FROM rooms WHERE room_id = ?', [roomId], (err, result) => {
            if (err) {
                console.error('Database error:', err);
                return res.status(500).send('Internal server error.');
            }

            if (result.length === 0) {
                return res.status(404).send('Room not found.');
            }

            res.sendFile(path.join(__dirname, 'public', 'room.html'));
        });
    }
});

app.get('/api/check-session', (req, res) => {
    console.log('Checking session:', req.session);
    if (req.session && req.session.username) {
        console.log('Session found:', req.session.username);
        res.json({ loggedIn: true, username: req.session.username });
    } else {
        console.log('No session found');
        res.json({ loggedIn: false });
    }
});

app.get('/api/check-session', (req, res) => {
    const response = { loggedIn: !!req.session.username, username: req.session.username };
    console.log(response);  // Log the response object
    res.json(response);
});

app.get('/joinroom/:roomId', (req, res) => {
    if (!req.session.username) {
        return res.redirect('/login.html');
    }

    // Assuming you have a method to validate the roomId
    if (isValidRoomId(req.params.roomId)) {
        res.sendFile(path.join(__dirname, 'public', 'joinroom.html'));
    } else {
        res.status(404).send('Room not found');
    }
});

// Handle unmatched routes
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Start the server
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});