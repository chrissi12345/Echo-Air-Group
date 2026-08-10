const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const path = require("path");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const JWT_SECRET =
    process.env.JWT_SECRET || "CHANGE_THIS_SECRET";

const DB_PATH =
    process.env.DB_PATH ||
    path.join(__dirname, "echo.db");

// ============================================================
// ENVIRONMENT
// ============================================================

if (!process.env.NEWSKY_API_KEY) {
    console.warn(
        "WARNING: NEWSKY_API_KEY is missing."
    );
}

if (!process.env.JWT_SECRET) {
    console.warn(
        "WARNING: JWT_SECRET is missing."
    );
}

// ============================================================
// NEW SKY SETTINGS
// ============================================================
//
// NewSky returns flights in pages.
//
// We deliberately do NOT use one request with count = 100
// and stop there.
//
// Instead:
//
// page 1 -> skip 0
// page 2 -> skip 100
// page 3 -> skip 200
// page 4 -> skip 300
// ...
//
// until there are no more flights.
//
// You can increase this if Echo Air Group becomes very large.
//

const NEWSKY_PAGE_SIZE = Math.max(
    1,
    Number(
        process.env.NEWSKY_PAGE_SIZE || 100
    )
);

const NEWSKY_MAX_PAGES = Math.max(
    1,
    Number(
        process.env.NEWSKY_MAX_PAGES || 1000
    )
);

// ============================================================
// DATABASE
// ============================================================

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        username TEXT UNIQUE NOT NULL,

        password TEXT NOT NULL,

        display_name TEXT,

        newsky_pilot_id TEXT,

        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS flights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        user_id INTEGER NOT NULL,

        newsky_id TEXT NOT NULL,

        dep_icao TEXT,

        arr_icao TEXT,

        aircraft TEXT,

        rating REAL DEFAULT 0,

        duration REAL DEFAULT 0,

        distance REAL DEFAULT 0,

        stars REAL DEFAULT 0,

        dep_time TEXT,

        synced_at TEXT DEFAULT CURRENT_TIMESTAMP,

        FOREIGN KEY(user_id)
            REFERENCES users(id)
            ON DELETE CASCADE,

        UNIQUE(user_id, newsky_id)
    );
`);

// ============================================================
// DATABASE MIGRATIONS
// ============================================================

function columnExists(table, column) {
    const columns = db
        .prepare(
            `PRAGMA table_info(${table})`
        )
        .all();

    return columns.some(
        item => item.name === column
    );
}

if (!columnExists("users", "display_name")) {
    db.exec(`
        ALTER TABLE users
        ADD COLUMN display_name TEXT
    `);
}

if (!columnExists("users", "newsky_pilot_id")) {
    db.exec(`
        ALTER TABLE users
        ADD COLUMN newsky_pilot_id TEXT
    `);
}

if (!columnExists("flights", "user_id")) {
    throw new Error(
        "The flights table does not contain user_id."
    );
}

console.log(
    "Database ready:",
    DB_PATH
);

// ============================================================
// RANK SYSTEM
// ============================================================

const RANKS = [
    {
        name: "Cadet",
        stars: 0
    },

    {
        name: "First Officer",
        stars: 1000
    },

    {
        name: "Senior First Officer",
        stars: 2500
    },

    {
        name: "Captain",
        stars: 5000
    },

    {
        name: "Senior Captain",
        stars: 7500
    },

    {
        name: "Commander",
        stars: 10000
    }
];

function getRank(stars) {
    const value =
        Number(stars) || 0;

    let current =
        RANKS[0];

    let next =
        null;

    for (const rank of RANKS) {
        if (value >= rank.stars) {
            current = rank;
        } else {
            next = rank;
            break;
        }
    }

    return {
        current,
        next
    };
}

// ============================================================
// HELPERS
// ============================================================

function toNumber(
    value,
    fallback = 0
) {
    const number =
        Number(value);

    return Number.isFinite(number)
        ? number
        : fallback;
}

function round(
    value,
    decimals = 2
) {
    const factor =
        Math.pow(
            10,
            decimals
        );

    return Math.round(
        value * factor
    ) / factor;
}

function firstValue(
    object,
    keys
) {
    if (
        !object ||
        typeof object !== "object"
    ) {
        return null;
    }

    for (const key of keys) {
        if (
            object[key] !== undefined &&
            object[key] !== null &&
            object[key] !== ""
        ) {
            return object[key];
        }
    }

    return null;
}

// ============================================================
// NEWSKY PILOT ID
// ============================================================

function getPilotId(flight) {
    if (
        !flight ||
        typeof flight !== "object"
    ) {
        return "";
    }

    const direct =
        firstValue(
            flight,
            [
                "pilotId",
                "pilotID",
                "pilot_id",
                "newskyPilotId",
                "newsky_pilot_id"
            ]
        );

    if (direct !== null) {
        return String(
            direct
        ).trim();
    }

    if (
        flight.pilot &&
        typeof flight.pilot === "object"
    ) {
        const nested =
            firstValue(
                flight.pilot,
                [
                    "_id",
                    "id",
                    "pilotId",
                    "pilotID",
                    "newskyPilotId",
                    "newsky_pilot_id"
                ]
            );

        if (nested !== null) {
            return String(
                nested
            ).trim();
        }
    }

    if (
        flight.user &&
        typeof flight.user === "object"
    ) {
        const nested =
            firstValue(
                flight.user,
                [
                    "_id",
                    "id",
                    "pilotId",
                    "pilotID"
                ]
            );

        if (nested !== null) {
            return String(
                nested
            ).trim();
        }
    }

    if (
        flight.pilotProfile &&
        typeof flight.pilotProfile === "object"
    ) {
        const nested =
            firstValue(
                flight.pilotProfile,
                [
                    "_id",
                    "id",
                    "pilotId",
                    "pilotID"
                ]
            );

        if (nested !== null) {
            return String(
                nested
            ).trim();
        }
    }

    return "";
}

// ============================================================
// NEWSKY FLIGHT ID
// ============================================================

function getNewSkyFlightId(flight) {
    const value =
        firstValue(
            flight,
            [
                "_id",
                "id",
                "flightId",
                "flightID",
                "flight_id",
                "uuid"
            ]
        );

    if (value === null) {
        return null;
    }

    return String(value).trim();
}

// ============================================================
// AIRPORT CODE
// ============================================================

function extractAirportCode(
    value,
    depth = 0
) {
    if (
        value === null ||
        value === undefined ||
        depth > 6
    ) {
        return null;
    }

    if (typeof value === "string") {
        const text =
            value.trim();

        if (!text) {
            return null;
        }

        return text;
    }

    if (typeof value === "number") {
        return String(value);
    }

    if (
        typeof value === "object" &&
        !Array.isArray(value)
    ) {
        const directCode =
            firstValue(
                value,
                [
                    "icao",
                    "ICAO",
                    "icaoCode",
                    "ICAOCode",
                    "icao_code",

                    "iata",
                    "IATA",
                    "iataCode",
                    "IATACode",
                    "iata_code",

                    "airportCode",
                    "airport_code",

                    "code",
                    "identifier"
                ]
            );

        if (
            directCode !== null &&
            typeof directCode !== "object"
        ) {
            const code =
                String(
                    directCode
                ).trim();

            if (code) {
                return code;
            }
        }

        const nestedAirport =
            firstValue(
                value,
                [
                    "airport",
                    "Airport",
                    "airportData",
                    "airportInfo",
                    "location"
                ]
            );

        if (
            nestedAirport !== null
        ) {
            const nestedCode =
                extractAirportCode(
                    nestedAirport,
                    depth + 1
                );

            if (nestedCode) {
                return nestedCode;
            }
        }

        for (
            const key
            of Object.keys(value)
        ) {
            const nestedValue =
                value[key];

            if (
                nestedValue === null ||
                nestedValue === undefined
            ) {
                continue;
            }

            if (
                typeof nestedValue === "object"
            ) {
                const nestedCode =
                    extractAirportCode(
                        nestedValue,
                        depth + 1
                    );

                if (nestedCode) {
                    return nestedCode;
                }
            }
        }
    }

    return null;
}

// ============================================================
// DEPARTURE
// ============================================================

function getDeparture(flight) {
    const raw =
        firstValue(
            flight,
            [
                "depIcao",
                "departureIcao",
                "departureICAO",
                "dep_icao",

                "departure",
                "origin",
                "from",
                "dep"
            ]
        );

    return extractAirportCode(
        raw
    );
}

// ============================================================
// ARRIVAL
// ============================================================

function getArrival(flight) {
    const raw =
        firstValue(
            flight,
            [
                "arrIcao",
                "arrivalIcao",
                "arrivalICAO",
                "arr_icao",

                "arrival",
                "destination",
                "to",
                "arr"
            ]
        );

    return extractAirportCode(
        raw
    );
}

// ============================================================
// AIRCRAFT
// ============================================================

function getAircraft(flight) {
    const aircraft =
        firstValue(
            flight,
            [
                "aircraft",
                "aircraftName",
                "aircraftType",
                "aircraftModel",
                "plane",
                "planeName",
                "equipment",
                "aircraftIcao",
                "aircraftICAO",
                "type"
            ]
        );

    if (
        aircraft &&
        typeof aircraft === "object"
    ) {
        return (
            aircraft.name ||
            aircraft.model ||
            aircraft.icao ||
            aircraft.type ||
            "Unknown aircraft"
        );
    }

    return (
        aircraft ||
        "Unknown aircraft"
    );
}

// ============================================================
// RATING
// ============================================================

function getRating(flight) {
    const rating =
        firstValue(
            flight,
            [
                "rating",
                "flightRating",
                "score",
                "grade",
                "performanceRating"
            ]
        );

    return toNumber(
        rating
    );
}

// ============================================================
// DURATION
// ============================================================

function getDurationMinutes(flight) {
    const value =
        firstValue(
            flight,
            [
                "duration",
                "durationMinutes",
                "flightDuration",
                "minutes",
                "flightTime"
            ]
        );

    if (value === null) {
        return 0;
    }

    if (
        typeof value === "string" &&
        value.includes(":")
    ) {
        const parts =
            value
                .split(":")
                .map(Number);

        if (parts.length === 2) {
            return (
                parts[0] * 60 +
                parts[1]
            );
        }

        if (parts.length === 3) {
            return (
                parts[0] * 60 +
                parts[1] +
                parts[2] / 60
            );
        }
    }

    return toNumber(
        value
    );
}

// ============================================================
// DISTANCE
// ============================================================

function getDistance(flight) {
    const value =
        firstValue(
            flight,
            [
                "distance",
                "distanceKm",
                "distance_km",
                "routeDistance",
                "distanceFlown"
            ]
        );

    return toNumber(
        value
    );
}

// ============================================================
// DATE
// ============================================================

function getFlightDate(flight) {
    return firstValue(
        flight,
        [
            "depTimeAct",
            "depTime",
            "departureTime",
            "departureDate",
            "date",
            "createdAt",
            "flightDate"
        ]
    );
}

// ============================================================
// STARS
// ============================================================
//
// Stars:
//
// flight minutes
// + distance / 10
// + rating
//
// Example:
//
// 54 minutes
// + 120 km / 10
// + 9.87 rating
//
// = 75.87 stars
//
// Decimal values are preserved.
//

function calculateFlightStars(
    duration,
    distance,
    rating
) {
    const minutes =
        toNumber(
            duration
        );

    const km =
        toNumber(
            distance
        );

    const flightRating =
        toNumber(
            rating
        );

    return round(
        minutes +
        (km / 10) +
        flightRating,
        2
    );
}

// ============================================================
// FORMAT FLIGHT
// ============================================================

function formatFlight(
    flight
) {
    return {
        id:
            flight.id,

        newskyId:
            flight.newsky_id,

        depIcao:
            flight.dep_icao,

        arrIcao:
            flight.arr_icao,

        aircraft:
            flight.aircraft,

        rating:
            round(
                toNumber(
                    flight.rating
                ),
                2
            ),

        duration:
            round(
                toNumber(
                    flight.duration
                ),
                2
            ),

        distance:
            round(
                toNumber(
                    flight.distance
                ),
                2
            ),

        stars:
            round(
                toNumber(
                    flight.stars
                ),
                2
            ),

        depTime:
            flight.dep_time,

        syncedAt:
            flight.synced_at
    };
}

// ============================================================
// ACHIEVEMENTS
// ============================================================

function getAchievements(
    stats
) {
    return [
        {
            id: "first-flight",
            name: "First Flight",
            description:
                "Complete your first flight.",
            icon: "🛫",
            unlocked:
                stats.flightCount >= 1
        },

        {
            id: "airborne",
            name: "Airborne",
            description:
                "Complete 10 flights.",
            icon: "✈️",
            unlocked:
                stats.flightCount >= 10
        },

        {
            id: "pilot",
            name: "Experienced Pilot",
            description:
                "Complete 50 flights.",
            icon: "👨‍✈️",
            unlocked:
                stats.flightCount >= 50
        },

        {
            id: "veteran",
            name: "Veteran Pilot",
            description:
                "Complete 100 flights.",
            icon: "🎖️",
            unlocked:
                stats.flightCount >= 100
        },

        {
            id: "globetrotter",
            name: "Globetrotter",
            description:
                "Fly 10,000 km.",
            icon: "🌍",
            unlocked:
                stats.distance >= 10000
        },

        {
            id: "world-traveler",
            name: "World Traveler",
            description:
                "Fly 50,000 km.",
            icon: "🌎",
            unlocked:
                stats.distance >= 50000
        },

        {
            id: "explorer",
            name: "Explorer",
            description:
                "Fly 100,000 km.",
            icon: "🧭",
            unlocked:
                stats.distance >= 100000
        },

        {
            id: "long-haul",
            name: "Long Hauler",
            description:
                "Fly 100 flight hours.",
            icon: "⏱️",
            unlocked:
                stats.flightHours >= 100
        },

        {
            id: "sky-master",
            name: "Sky Master",
            description:
                "Fly 250 flight hours.",
            icon: "☁️",
            unlocked:
                stats.flightHours >= 250
        },

        {
            id: "five-star",
            name: "Five Star Pilot",
            description:
                "Achieve an average rating of 5.00.",
            icon: "⭐",
            unlocked:
                stats.flightCount > 0 &&
                stats.averageRating >= 5
        },

        {
            id: "first-officer",
            name: "First Officer",
            description:
                "Reach 1,000 stars.",
            icon: "🥇",
            unlocked:
                stats.stars >= 1000
        },

        {
            id: "captain",
            name: "Captain",
            description:
                "Reach 5,000 stars.",
            icon: "🏆",
            unlocked:
                stats.stars >= 5000
        },

        {
            id: "senior-captain",
            name: "Senior Captain",
            description:
                "Reach 7,500 stars.",
            icon: "👑",
            unlocked:
                stats.stars >= 7500
        },

        {
            id: "commander",
            name: "Commander",
            description:
                "Reach 10,000 stars.",
            icon: "🚀",
            unlocked:
                stats.stars >= 10000
        }
    ];
}

// ============================================================
// USER STATS
// ============================================================

function getUserStats(
    userId
) {
    const flights =
        db.prepare(`
            SELECT *
            FROM flights
            WHERE user_id = ?
            ORDER BY
                datetime(dep_time) DESC,
                id DESC
        `).all(
            userId
        );

    const flightCount =
        flights.length;

    const stars =
        flights.reduce(
            (
                total,
                flight
            ) =>
                total +
                toNumber(
                    flight.stars
                ),
            0
        );

    const distance =
        flights.reduce(
            (
                total,
                flight
            ) =>
                total +
                toNumber(
                    flight.distance
                ),
            0
        );

    const duration =
        flights.reduce(
            (
                total,
                flight
            ) =>
                total +
                toNumber(
                    flight.duration
                ),
            0
        );

    const ratingTotal =
        flights.reduce(
            (
                total,
                flight
            ) =>
                total +
                toNumber(
                    flight.rating
                ),
            0
        );

    const averageRating =
        flightCount > 0
            ? ratingTotal /
              flightCount
            : 0;

    const flightHours =
        duration / 60;

    const rankData =
        getRank(
            stars
        );

    let progress = 100;

    if (rankData.next) {
        progress =
            (
                (
                    stars -
                    rankData.current.stars
                ) /
                (
                    rankData.next.stars -
                    rankData.current.stars
                )
            ) * 100;

        progress =
            Math.max(
                0,
                Math.min(
                    100,
                    progress
                )
            );
    }

    return {
        flights,

        flightCount,

        stars:
            round(
                stars,
                2
            ),

        distance:
            round(
                distance,
                2
            ),

        duration:
            round(
                duration,
                2
            ),

        flightHours:
            round(
                flightHours,
                1
            ),

        averageRating:
            round(
                averageRating,
                2
            ),

        rank:
            rankData.current,

        nextRank:
            rankData.next,

        progress:
            round(
                progress,
                1
            )
    };
}

// ============================================================
// AUTHENTICATION
// ============================================================

function createToken(
    user
) {
    return jwt.sign(
        {
            id:
                user.id,

            username:
                user.username
        },

        JWT_SECRET,

        {
            expiresIn:
                "30d"
        }
    );
}

function authenticate(
    req,
    res,
    next
) {
    const header =
        req.headers.authorization;

    if (
        !header ||
        !header.startsWith(
            "Bearer "
        )
    ) {
        return res.status(401).json({
            error:
                "Authentication required"
        });
    }

    const token =
        header.substring(7);

    try {
        const decoded =
            jwt.verify(
                token,
                JWT_SECRET
            );

        const user =
            db.prepare(`
                SELECT *
                FROM users
                WHERE id = ?
            `).get(
                decoded.id
            );

        if (!user) {
            return res.status(401).json({
                error:
                    "User not found"
            });
        }

        req.user =
            user;

        next();

    } catch (error) {
        return res.status(401).json({
            error:
                "Invalid or expired token"
        });
    }
}

// ============================================================
// ROOT
// ============================================================

app.get(
    "/",
    (req, res) => {
        res.json({
            message:
                "Echo Air Group backend is running!",

            database:
                DB_PATH,

            time:
                new Date().toISOString()
        });
    }
);

// ============================================================
// HEALTH
// ============================================================

app.get(
    "/api/health",
    (req, res) => {
        res.json({
            status:
                "ok",

            database:
                "connected",

            time:
                new Date().toISOString()
        });
    }
);

// ============================================================
// REGISTER
// ============================================================

app.post(
    "/api/auth/register",
    async (req, res) => {
        try {
            let {
                username,
                password
            } = req.body;

            username =
                String(
                    username || ""
                ).trim();

            password =
                String(
                    password || ""
                );

            if (
                !username ||
                !password
            ) {
                return res.status(400).json({
                    error:
                        "Username and password are required"
                });
            }

            if (
                username.length < 3
            ) {
                return res.status(400).json({
                    error:
                        "Username must be at least 3 characters"
                });
            }

            if (
                password.length < 8
            ) {
                return res.status(400).json({
                    error:
                        "Password must be at least 8 characters"
                });
            }

            const existing =
                db.prepare(`
                    SELECT id
                    FROM users
                    WHERE LOWER(username) = LOWER(?)
                `).get(
                    username
                );

            if (existing) {
                return res.status(409).json({
                    error:
                        "Username already exists. Please choose another username."
                });
            }

            const passwordHash =
                await bcrypt.hash(
                    password,
                    12
                );

            const result =
                db.prepare(`
                    INSERT INTO users
                    (
                        username,
                        password,
                        display_name
                    )
                    VALUES (?, ?, ?)
                `).run(
                    username,
                    passwordHash,
                    username
                );

            const user = {
                id:
                    result.lastInsertRowid,

                username
            };

            const token =
                createToken(
                    user
                );

            res.status(201).json({
                message:
                    "Account created",

                token
            });

        } catch (error) {
            console.error(
                "Register error:",
                error
            );

            res.status(500).json({
                error:
                    "Could not create account"
            });
        }
    }
);

// ============================================================
// LOGIN
// ============================================================

app.post(
    "/api/auth/login",
    async (req, res) => {
        try {
            const username =
                String(
                    req.body.username || ""
                ).trim();

            const password =
                String(
                    req.body.password || ""
                );

            const user =
                db.prepare(`
                    SELECT *
                    FROM users
                    WHERE LOWER(username) = LOWER(?)
                `).get(
                    username
                );

            if (!user) {
                return res.status(401).json({
                    error:
                        "Invalid username or password"
                });
            }

            const valid =
                await bcrypt.compare(
                    password,
                    user.password
                );

            if (!valid) {
                return res.status(401).json({
                    error:
                        "Invalid username or password"
                });
            }

            const token =
                createToken(
                    user
                );

            res.json({
                message:
                    "Login successful",

                token
            });

        } catch (error) {
            console.error(
                "Login error:",
                error
            );

            res.status(500).json({
                error:
                    "Could not login"
            });
        }
    }
);

// ============================================================
// MY PROFILE
// ============================================================

app.get(
    "/api/me",
    authenticate,
    (req, res) => {
        const stats =
            getUserStats(
                req.user.id
            );

        res.json({
            user: {
                id:
                    req.user.id,

                username:
                    req.user.username,

                displayName:
                    req.user.display_name ||
                    req.user.username,

                newskyPilotId:
                    req.user.newsky_pilot_id ||
                    ""
            },

            stats: {
                stars:
                    stats.stars,

                rank:
                    stats.rank.name,

                rankMin:
                    stats.rank.stars,

                nextRank:
                    stats.nextRank,

                progress:
                    stats.progress,

                flightCount:
                    stats.flightCount,

                distance:
                    stats.distance,

                flightHours:
                    stats.flightHours,

                averageRating:
                    stats.averageRating
            },

            achievements:
                getAchievements(
                    stats
                ),

            flights:
                stats.flights
                    .slice(0, 25)
                    .map(
                        formatFlight
                    )
        });
    }
);

// ============================================================
// LINK NEWSKY ACCOUNT
// ============================================================

app.post(
    "/api/account/link",
    authenticate,
    (req, res) => {
        const cleanId =
            String(
                req.body.newskyPilotId ||
                ""
            ).trim();

        if (!cleanId) {
            return res.status(400).json({
                error:
                    "NewSky Pilot ID is required"
            });
        }

        db.prepare(`
            UPDATE users
            SET newsky_pilot_id = ?
            WHERE id = ?
        `).run(
            cleanId,
            req.user.id
        );

        res.json({
            message:
                "NewSky Pilot ID linked successfully.",

            newskyPilotId:
                cleanId
        });
    }
);

// ============================================================
// EXTRACT FLIGHTS FROM NEWSKY RESPONSE
// ============================================================

function extractFlights(
    data
) {
    if (Array.isArray(data)) {
        return data;
    }

    if (
        data &&
        Array.isArray(
            data.flights
        )
    ) {
        return data.flights;
    }

    if (
        data &&
        data.data &&
        Array.isArray(
            data.data
        )
    ) {
        return data.data;
    }

    if (
        data &&
        data.data &&
        Array.isArray(
            data.data.flights
        )
    ) {
        return data.data.flights;
    }

    if (
        data &&
        Array.isArray(
            data.results
        )
    ) {
        return data.results;
    }

    if (
        data &&
        data.result &&
        Array.isArray(
            data.result
        )
    ) {
        return data.result;
    }

    if (
        data &&
        data.result &&
        Array.isArray(
            data.result.flights
        )
    ) {
        return data.result.flights;
    }

    return [];
}

// ============================================================
// GET ONE NEWSKY PAGE
// ============================================================

async function getNewSkyFlightPage(
    skip
) {
    if (!process.env.NEWSKY_API_KEY) {
        throw new Error(
            "NEWSKY_API_KEY is not configured."
        );
    }

    const body = {
        skip,
        count:
            NEWSKY_PAGE_SIZE,

        includeDeleted:
            false
    };

    console.log(
        `NewSky request: skip=${skip}, count=${NEWSKY_PAGE_SIZE}`
    );

    const response =
        await fetch(
            "https://newsky.app/api/airline-api/flights/recent",
            {
                method:
                    "POST",

                headers: {
                    Authorization:
                        `Bearer ${process.env.NEWSKY_API_KEY}`,

                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify(
                        body
                    )
            }
        );

    const text =
    await response.text();

let data;

try {
    data =
        JSON.parse(
            text
        );
} catch {
    throw new Error(
        "NewSky returned an invalid JSON response."
    );
}

console.log("NEWSKY RAW RESPONSE:");
console.log(JSON.stringify(data, null, 2));

if (!response.ok) {
    console.error(
        "NewSky API error:",
        data
    );

    throw new Error(
        data.error ||
        data.message ||
        `NewSky API returned ${response.status}`
    );
}

const flights =
    extractFlights(
        data
    );

return {
    data,
    flights
};
    
// ============================================================
// GET ALL NEWSKY FLIGHTS
// ============================================================
//
// This is the important part.
//
// We keep requesting pages until:
//
// 1. NewSky returns zero flights
// 2. NewSky returns fewer flights than the page size
// 3. We reach NEWSKY_MAX_PAGES
//
// We also protect against the API returning the same page twice.
//

async function getAllNewSkyFlights() {
    const allFlights = [];

    const seenIds =
        new Set();

    let skip = 0;

    let pagesFetched = 0;

    let duplicatePages = 0;

    while (
        pagesFetched <
        NEWSKY_MAX_PAGES
    ) {
        const page =
            await getNewSkyFlightPage(
                skip
            );

        pagesFetched++;

        const flights =
            page.flights;

        console.log(
            `NewSky page ${pagesFetched}: ${flights.length} flight(s)`
        );

        if (
            flights.length === 0
        ) {
            console.log(
                "NewSky returned an empty page. Pagination finished."
            );

            break;
        }

        let newFlightsThisPage = 0;

        for (
            const flight
            of flights
        ) {
            const flightId =
                getNewSkyFlightId(
                    flight
                );

            if (
                flightId &&
                seenIds.has(
                    flightId
                )
            ) {
                duplicatePages++;
                continue;
            }

            if (flightId) {
                seenIds.add(
                    flightId
                );
            }

            allFlights.push(
                flight
            );

            newFlightsThisPage++;
        }

        /*
         * If NewSky returned fewer than requested,
         * we reached the last page.
         */

        if (
            flights.length <
            NEWSKY_PAGE_SIZE
        ) {
            console.log(
                "Last NewSky page reached."
            );

            break;
        }

        /*
         * If the API returned a full page but
         * absolutely nothing new, continuing would
         * create an infinite loop.
         */

        if (
            newFlightsThisPage === 0
        ) {
            console.warn(
                "NewSky returned no new flights. Stopping pagination."
            );

            break;
        }

        skip +=
            NEWSKY_PAGE_SIZE;
    }

    if (
        pagesFetched >=
        NEWSKY_MAX_PAGES
    ) {
        console.warn(
            `NEWSKY_MAX_PAGES (${NEWSKY_MAX_PAGES}) reached.`
        );
    }

    console.log(
        `NewSky pagination finished: ${allFlights.length} unique flight(s), ${pagesFetched} page(s).`
    );

    return {
        flights:
            allFlights,

        pagesFetched,

        duplicatePages
    };
}

// ============================================================
// GET ALL LINKED PILOTS
// ============================================================

function getLinkedPilots() {
    return db.prepare(`
        SELECT
            id,
            username,
            display_name,
            newsky_pilot_id
        FROM users
        WHERE
            newsky_pilot_id IS NOT NULL
            AND TRIM(newsky_pilot_id) != ''
        ORDER BY id ASC
    `).all();
}

// ============================================================
// PILOT LOOKUP
// ============================================================

function buildPilotLookup(
    pilots
) {
    const lookup =
        new Map();

    for (
        const pilot
        of pilots
    ) {
        const pilotId =
            String(
                pilot.newsky_pilot_id
            ).trim();

        if (!pilotId) {
            continue;
        }

        lookup.set(
            pilotId,
            pilot
        );
    }

    return lookup;
}

// ============================================================
// UPSERT FLIGHT
// ============================================================

const upsertFlight =
    db.prepare(`
        INSERT INTO flights
        (
            user_id,
            newsky_id,
            dep_icao,
            arr_icao,
            aircraft,
            rating,
            duration,
            distance,
            stars,
            dep_time,
            synced_at
        )
        VALUES
        (
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            ?,
            CURRENT_TIMESTAMP
        )

        ON CONFLICT(user_id, newsky_id)
        DO UPDATE SET

            dep_icao =
                excluded.dep_icao,

            arr_icao =
                excluded.arr_icao,

            aircraft =
                excluded.aircraft,

            rating =
                excluded.rating,

            duration =
                excluded.duration,

            distance =
                excluded.distance,

            stars =
                excluded.stars,

            dep_time =
                excluded.dep_time,

            synced_at =
                CURRENT_TIMESTAMP
    `);

// ============================================================
// SYNC ONE FLIGHT
// ============================================================

function prepareFlightForDatabase(
    flight
) {
    const newskyId =
        getNewSkyFlightId(
            flight
        );

    if (!newskyId) {
        return null;
    }

    const departure =
        getDeparture(
            flight
        );

    const arrival =
        getArrival(
            flight
        );

    const aircraft =
        getAircraft(
            flight
        );

    const rating =
        getRating(
            flight
        );

    const duration =
        getDurationMinutes(
            flight
        );

    const distance =
        getDistance(
            flight
        );

    const depTime =
        getFlightDate(
            flight
        );

    const stars =
        calculateFlightStars(
            duration,
            distance,
            rating
        );

    return {
        newskyId,

        departure:
            departure ||
            null,

        arrival:
            arrival ||
            null,

        aircraft:
            aircraft
                ? String(
                    aircraft
                )
                : null,

        rating,

        duration,

        distance,

        stars,

        depTime:
            depTime
                ? String(
                    depTime
                )
                : null
    };
}

// ============================================================
// CENTRAL SYNC
// ============================================================
//
// THIS is now the main synchronization endpoint.
//
// It does NOT sync only the logged-in pilot.
//
// It:
//
// 1. Gets every linked Echo Air Group pilot
// 2. Gets every available NewSky flight through pagination
// 3. Reads the Pilot ID from each flight
// 4. Finds the matching Echo user
// 5. Saves the flight to that user's account
//
// Therefore the ranking can use ALL Echo Air Group flights.
//

app.post(
    "/api/sync/all",
    authenticate,
    async (req, res) => {
        try {
            console.log(
                "================================================"
            );

            console.log(
                "STARTING ECHO AIR GROUP FULL SYNC"
            );

            console.log(
                "================================================"
            );

            const pilots =
                getLinkedPilots();

            if (
                pilots.length === 0
            ) {
                return res.status(400).json({
                    error:
                        "No Echo Air Group pilots have linked their NewSky Pilot ID yet.",

                    linkedPilots:
                        0
                });
            }

            console.log(
                `Found ${pilots.length} linked Echo Air Group pilot(s).`
            );

            const pilotLookup =
                buildPilotLookup(
                    pilots
                );

            const {
                flights,
                pagesFetched,
                duplicatePages
            } =
                await getAllNewSkyFlights();

            console.log(
                `Total unique NewSky flights received: ${flights.length}`
            );

            let linkedFlights =
                0;

            let imported =
                0;

            let skipped =
                0;

            let flightsWithoutMatchingPilot =
                0;

            const pilotFlightCounts =
                new Map();

            for (
                const pilot
                of pilots
            ) {
                pilotFlightCounts.set(
                    pilot.id,
                    0
                );
            }

            /*
             * Use one transaction for the complete
             * synchronization.
             *
             * This makes the database much faster
             * when importing hundreds or thousands
             * of flights.
             */

            const transaction =
                db.transaction(
                    allFlights => {
                        for (
                            const flight
                            of allFlights
                        ) {
                            const pilotId =
                                getPilotId(
                                    flight
                                );

                            if (!pilotId) {
                                flightsWithoutMatchingPilot++;
                                continue;
                            }

                            const pilot =
                                pilotLookup.get(
                                    String(
                                        pilotId
                                    ).trim()
                                );

                            if (!pilot) {
                                flightsWithoutMatchingPilot++;
                                continue;
                            }

                            linkedFlights++;

                            const prepared =
                                prepareFlightForDatabase(
                                    flight
                                );

                            if (!prepared) {
                                skipped++;
                                continue;
                            }

                            upsertFlight.run(
                                pilot.id,

                                prepared.newskyId,

                                prepared.departure,

                                prepared.arrival,

                                prepared.aircraft,

                                prepared.rating,

                                prepared.duration,

                                prepared.distance,

                                prepared.stars,

                                prepared.depTime
                            );

                            imported++;

                            pilotFlightCounts.set(
                                pilot.id,
                                (
                                    pilotFlightCounts.get(
                                        pilot.id
                                    ) || 0
                                ) + 1
                            );
                        }
                    }
                );

            transaction(
                flights
            );

            const totalFlightsInDatabase =
                db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM flights
                `).get().count;

            const pilotsWithFlights =
                db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM (
                        SELECT DISTINCT user_id
                        FROM flights
                    )
                `).get().count;

            const pilotResults =
                pilots.map(
                    pilot => {
                        const stats =
                            getUserStats(
                                pilot.id
                            );

                        return {
                            userId:
                                pilot.id,

                            username:
                                pilot.username,

                            displayName:
                                pilot.display_name ||
                                pilot.username,

                            newskyPilotId:
                                pilot.newsky_pilot_id,

                            flightsFoundInSync:
                                pilotFlightCounts.get(
                                    pilot.id
                                ) || 0,

                            totalFlightsInDatabase:
                                stats.flightCount,

                            stars:
                                stats.stars,

                            rank:
                                stats.rank.name
                        };
                    }
                );

            console.log(
                "================================================"
            );

            console.log(
                "ECHO AIR GROUP FULL SYNC FINISHED"
            );

            console.log(
                `Pages fetched: ${pagesFetched}`
            );

            console.log(
                `NewSky flights: ${flights.length}`
            );

            console.log(
                `Linked flights: ${linkedFlights}`
            );

            console.log(
                `Imported/updated: ${imported}`
            );

            console.log(
                `Skipped: ${skipped}`
            );

            console.log(
                `Without matching pilot: ${flightsWithoutMatchingPilot}`
            );

            console.log(
                `Database flights: ${totalFlightsInDatabase}`
            );

            console.log(
                "================================================"
            );

            res.json({
                message:
                    "Echo Air Group full flight synchronization completed.",

                newskyFlightsReceived:
                    flights.length,

                pagesFetched,

                linkedPilots:
                    pilots.length,

                linkedFlights,

                flightsImported:
                    imported,

                flightsSkipped:
                    skipped,

                flightsWithoutMatchingPilot,

                pilotsWithFlights,

                totalFlightsInDatabase,

                duplicateFlightsIgnored:
                    duplicatePages,

                pilots:
                    pilotResults
            });

        } catch (error) {
            console.error(
                "FULL SYNC ERROR:",
                error
            );

            res.status(500).json({
                error:
                    error.message ||
                    "Unable to synchronize Echo Air Group flights."
            });
        }
    }
);

// ============================================================
// OLD PERSONAL SYNC
// ============================================================
//
// Kept for backwards compatibility.
//
// The frontend can still call /api/sync/me,
// but the new recommended endpoint is:
//
// POST /api/sync/all
//
// The personal endpoint only imports flights
// belonging to the currently logged-in pilot.
//

app.post(
    "/api/sync/me",
    authenticate,
    async (req, res) => {
        try {
            const pilotId =
                String(
                    req.user.newsky_pilot_id ||
                    ""
                ).trim();

            if (!pilotId) {
                return res.status(400).json({
                    error:
                        "Please link your NewSky Pilot ID first."
                });
            }

            const {
                flights
            } =
                await getAllNewSkyFlights();

            const pilotFlights =
                flights.filter(
                    flight =>
                        String(
                            getPilotId(
                                flight
                            )
                        ).trim() ===
                        pilotId
                );

            let imported =
                0;

            let skipped =
                0;

            const transaction =
                db.transaction(
                    flightList => {
                        for (
                            const flight
                            of flightList
                        ) {
                            const prepared =
                                prepareFlightForDatabase(
                                    flight
                                );

                            if (!prepared) {
                                skipped++;
                                continue;
                            }

                            upsertFlight.run(
                                req.user.id,

                                prepared.newskyId,

                                prepared.departure,

                                prepared.arrival,

                                prepared.aircraft,

                                prepared.rating,

                                prepared.duration,

                                prepared.distance,

                                prepared.stars,

                                prepared.depTime
                            );

                            imported++;
                        }
                    }
                );

            transaction(
                pilotFlights
            );

            const stats =
                getUserStats(
                    req.user.id
                );

            res.json({
                message:
                    `${imported} flight(s) found for your NewSky Pilot ID.`,

                newskyFlightsReceived:
                    flights.length,

                pilotFlightsFound:
                    pilotFlights.length,

                flightsImported:
                    imported,

                flightsSkipped:
                    skipped,

                stats: {
                    stars:
                        stats.stars,

                    flightCount:
                        stats.flightCount,

                    averageRating:
                        stats.averageRating,

                    flightHours:
                        stats.flightHours
                }
            });

        } catch (error) {
            console.error(
                "Personal sync error:",
                error
            );

            res.status(500).json({
                error:
                    error.message ||
                    "Unable to synchronize flights."
            });
        }
    }
);

// ============================================================
// PILOT SIDEBAR
// ============================================================

app.get(
    "/api/pilots",
    (req, res) => {
        try {
            const users =
                db.prepare(`
                    SELECT
                        id,
                        username,
                        display_name,
                        newsky_pilot_id,
                        created_at
                    FROM users
                    ORDER BY
                        LOWER(
                            COALESCE(
                                display_name,
                                username
                            )
                        ) ASC
                `).all();

            const pilots =
                users.map(
                    user => {
                        const stats =
                            getUserStats(
                                user.id
                            );

                        return {
                            id:
                                user.id,

                            username:
                                user.username,

                            displayName:
                                user.display_name ||
                                user.username,

                            rank:
                                stats.rank.name,

                            stars:
                                stats.stars,

                            flightCount:
                                stats.flightCount,

                            averageRating:
                                stats.averageRating,

                            flightHours:
                                stats.flightHours,

                            distance:
                                stats.distance,

                            newskyLinked:
                                Boolean(
                                    user.newsky_pilot_id
                                ),

                            createdAt:
                                user.created_at
                        };
                    }
                );

            res.json({
                pilots
            });

        } catch (error) {
            console.error(
                "Pilot list error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to load pilots."
            });
        }
    }
);

// ============================================================
// PUBLIC PILOT PROFILE
// ============================================================

app.get(
    "/api/pilots/:id",
    (req, res) => {
        try {
            const userId =
                Number(
                    req.params.id
                );

            if (
                !Number.isInteger(
                    userId
                )
            ) {
                return res.status(400).json({
                    error:
                        "Invalid pilot ID."
                });
            }

            const user =
                db.prepare(`
                    SELECT
                        id,
                        username,
                        display_name,
                        created_at
                    FROM users
                    WHERE id = ?
                `).get(
                    userId
                );

            if (!user) {
                return res.status(404).json({
                    error:
                        "Pilot not found."
                });
            }

            const stats =
                getUserStats(
                    user.id
                );

            res.json({
                pilot: {
                    id:
                        user.id,

                    username:
                        user.username,

                    displayName:
                        user.display_name ||
                        user.username,

                    rank:
                        stats.rank.name,

                    stars:
                        stats.stars,

                    flightCount:
                        stats.flightCount,

                    averageRating:
                        stats.averageRating,

                    flightHours:
                        stats.flightHours,

                    distance:
                        stats.distance,

                    createdAt:
                        user.created_at
                },

                flights:
                    stats.flights
                        .slice(0, 25)
                        .map(
                            formatFlight
                        )
            });

        } catch (error) {
            console.error(
                "Pilot profile error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to load pilot profile."
            });
        }
    }
);

// ============================================================
// LEADERBOARD
// ============================================================

app.get(
    "/api/ranking",
    (req, res) => {
        try {
            const users =
                db.prepare(`
                    SELECT
                        id,
                        username,
                        display_name
                    FROM users
                `).all();

            const rankings =
                users
                    .map(
                        user => {
                            const stats =
                                getUserStats(
                                    user.id
                                );

                            return {
                                id:
                                    user.id,

                                name:
                                    user.display_name ||
                                    user.username,

                                username:
                                    user.username,

                                stars:
                                    stats.stars,

                                flights:
                                    stats.flightCount,

                                flightCount:
                                    stats.flightCount,

                                averageRating:
                                    stats.averageRating,

                                rank:
                                    stats.rank.name
                            };
                        }
                    )
                    .sort(
                        (
                            a,
                            b
                        ) => {
                            if (
                                b.stars !==
                                a.stars
                            ) {
                                return (
                                    b.stars -
                                    a.stars
                                );
                            }

                            if (
                                b.averageRating !==
                                a.averageRating
                            ) {
                                return (
                                    b.averageRating -
                                    a.averageRating
                                );
                            }

                            return (
                                b.flights -
                                a.flights
                            );
                        }
                    )
                    .map(
                        (
                            pilot,
                            index
                        ) => ({
                            ...pilot,

                            position:
                                index + 1
                        })
                    );

            res.json({
                rankings
            });

        } catch (error) {
            console.error(
                "Ranking error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to load ranking."
            });
        }
    }
);

// ============================================================
// DATABASE DEBUG
// ============================================================

app.get(
    "/api/admin/database-stats",
    (req, res) => {
        try {
            const users =
                db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM users
                `).get().count;

            const flights =
                db.prepare(`
                    SELECT COUNT(*) AS count
                    FROM flights
                `).get().count;

            const usersWithFlights =
                db.prepare(`
                    SELECT
                        u.id,
                        u.username,
                        u.newsky_pilot_id,
                        COUNT(f.id) AS flights
                    FROM users u
                    LEFT JOIN flights f
                        ON f.user_id = u.id
                    GROUP BY
                        u.id
                    ORDER BY
                        u.id
                `).all();

            res.json({
                users,

                flights,

                usersWithFlights
            });

        } catch (error) {
            console.error(
                "Database stats error:",
                error
            );

            res.status(500).json({
                error:
                    "Unable to read database stats."
            });
        }
    }
);

// ============================================================
// 404
// ============================================================

app.use(
    (req, res) => {
        res.status(404).json({
            error:
                "Endpoint not found",

            path:
                req.originalUrl
        });
    }
);

// ============================================================
// ERROR HANDLER
// ============================================================

app.use(
    (
        error,
        req,
        res,
        next
    ) => {
        console.error(
            "Unhandled server error:",
            error
        );

        if (
            res.headersSent
        ) {
            return next(
                error
            );
        }

        res.status(500).json({
            error:
                "Internal server error"
        });
    }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    () => {
        console.log(
            `Echo Air Group backend running on port ${PORT}`
        );

        console.log(
            `Database: ${DB_PATH}`
        );

        console.log(
            `NewSky page size: ${NEWSKY_PAGE_SIZE}`
        );

        console.log(
            `NewSky max pages: ${NEWSKY_MAX_PAGES}`
        );
    }
);
