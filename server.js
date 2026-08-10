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
        "WARNING: JWT_SECRET is missing. Set a secure JWT_SECRET in .env"
    );
}

// ============================================================
// NEWSKY SETTINGS
// ============================================================

const NEWSKY_PAGE_SIZE = Math.max(
    1,
    Number(process.env.NEWSKY_PAGE_SIZE || 100)
);

const NEWSKY_MAX_PAGES = Math.max(
    1,
    Number(process.env.NEWSKY_MAX_PAGES || 1000)
);

const NEWSKY_FLIGHTS_URL =
    "https://newsky.app/api/airline-api/flights/recent";

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

        flight_number TEXT,

        dep_icao TEXT,

        arr_icao TEXT,

        aircraft TEXT,

        rating REAL DEFAULT 0,

        duration REAL DEFAULT 0,

        distance REAL DEFAULT 0,

        stars REAL DEFAULT 0,

        dep_time TEXT,

        simulator TEXT,

        penalties REAL DEFAULT 0,

        revenue REAL DEFAULT 0,

        balance REAL DEFAULT 0,

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
        .prepare(`PRAGMA table_info(${table})`)
        .all();

    return columns.some(
        item => item.name === column
    );
}

function addColumnIfMissing(
    table,
    column,
    definition
) {
    if (!columnExists(table, column)) {
        db.exec(`
            ALTER TABLE ${table}
            ADD COLUMN ${column} ${definition}
        `);
    }
}

addColumnIfMissing(
    "users",
    "display_name",
    "TEXT"
);

addColumnIfMissing(
    "users",
    "newsky_pilot_id",
    "TEXT"
);

addColumnIfMissing(
    "flights",
    "flight_number",
    "TEXT"
);

addColumnIfMissing(
    "flights",
    "simulator",
    "TEXT"
);

addColumnIfMissing(
    "flights",
    "penalties",
    "REAL DEFAULT 0"
);

addColumnIfMissing(
    "flights",
    "revenue",
    "REAL DEFAULT 0"
);

addColumnIfMissing(
    "flights",
    "balance",
    "REAL DEFAULT 0"
);

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

function cleanString(value) {
    if (
        value === null ||
        value === undefined
    ) {
        return "";
    }

    return String(value).trim();
}

// ============================================================
// NEWSKY FLIGHT ID
// ============================================================

function getNewSkyFlightId(flight) {
    if (
        !flight ||
        typeof flight !== "object"
    ) {
        return "";
    }

    const id =
        flight._id ||
        flight.id ||
        flight.flightId ||
        flight.flightID ||
        flight.flight_id ||
        flight.uuid;

    return cleanString(id);
}

// ============================================================
// NEWSKY PILOT ID
// ============================================================
//
// Exact structure from NewSky:
//
// "pilot": {
//     "_id": "...",
//     "fullname": "...",
//     "avatar": "..."
// }
//
// ============================================================

function getPilotId(flight) {
    if (
        !flight ||
        typeof flight !== "object"
    ) {
        return "";
    }

    if (
        flight.pilot &&
        typeof flight.pilot === "object"
    ) {
        return cleanString(
            flight.pilot._id ||
            flight.pilot.id
        );
    }

    return cleanString(
        flight.pilotId ||
        flight.pilotID ||
        flight.pilot_id
    );
}

// ============================================================
// PILOT NAME
// ============================================================

function getPilotName(flight) {
    if (
        flight &&
        flight.pilot &&
        typeof flight.pilot === "object"
    ) {
        return cleanString(
            flight.pilot.fullname
        );
    }

    return "";
}

// ============================================================
// DEPARTURE
// ============================================================
//
// Exact NewSky structure:
//
// "dep": {
//     "icao": "EDLW",
//     "name": "...",
//     "city": "..."
// }
//
// ============================================================

function getDeparture(flight) {
    if (
        flight &&
        flight.dep &&
        typeof flight.dep === "object"
    ) {
        return cleanString(
            flight.dep.icao
        );
    }

    return cleanString(
        flight.depIcao ||
        flight.departureIcao ||
        flight.departureICAO ||
        flight.dep_icao
    );
}

// ============================================================
// ARRIVAL
// ============================================================

function getArrival(flight) {
    if (
        flight &&
        flight.arr &&
        typeof flight.arr === "object"
    ) {
        return cleanString(
            flight.arr.icao
        );
    }

    return cleanString(
        flight.arrIcao ||
        flight.arrivalIcao ||
        flight.arrivalICAO ||
        flight.arr_icao
    );
}

// ============================================================
// AIRCRAFT
// ============================================================
//
// Exact NewSky structure:
//
// "aircraft": {
//     "name": "9H-EAM - IAE",
//     "airframe": {
//         "ident": "A320",
//         "icao": "A320",
//         "name": "Airbus A320"
//     }
// }
//
// We store the airframe name when available.
// Example:
// Airbus A320
//
// ============================================================

function getAircraft(flight) {
    if (
        flight &&
        flight.aircraft &&
        typeof flight.aircraft === "object"
    ) {
        if (
            flight.aircraft.airframe &&
            typeof flight.aircraft.airframe === "object"
        ) {
            return cleanString(
                flight.aircraft.airframe.name ||
                flight.aircraft.airframe.icao ||
                flight.aircraft.airframe.ident
            );
        }

        return cleanString(
            flight.aircraft.name ||
            flight.aircraft.model ||
            flight.aircraft.icao
        );
    }

    return cleanString(
        flight.aircraftName ||
        flight.aircraftType ||
        flight.aircraftModel
    );
}

// ============================================================
// RATING
// ============================================================
//
// NewSky:
// "rating": 9.87
//
// ============================================================

function getRating(flight) {
    return round(
        toNumber(
            flight?.rating
        ),
        2
    );
}

// ============================================================
// DURATION
// ============================================================
//
// IMPORTANT:
//
// NewSky has:
//
// "duration": 60
//
// but:
//
// "result": {
//     "totals": {
//         "time": 54
//     }
// }
//
// We use result.totals.time because this is the
// actual flight time used for the star calculation.
//
// ============================================================

function getDurationMinutes(flight) {
    if (
        flight &&
        flight.result &&
        flight.result.totals
    ) {
        const resultTime =
            toNumber(
                flight.result.totals.time,
                NaN
            );

        if (
            Number.isFinite(
                resultTime
            )
        ) {
            return resultTime;
        }
    }

    return toNumber(
        flight?.duration
    );
}

// ============================================================
// DISTANCE
// ============================================================
//
// NewSky:
//
// result.totals.distance
//
// Example:
//
// 279 km
//
// ============================================================

function getDistance(flight) {
    if (
        flight &&
        flight.result &&
        flight.result.totals
    ) {
        const distance =
            toNumber(
                flight.result.totals.distance,
                NaN
            );

        if (
            Number.isFinite(
                distance
            )
        ) {
            return distance;
        }
    }

    return toNumber(
        flight?.distance
    );
}

// ============================================================
// FLIGHT DATE
// ============================================================

function getFlightDate(flight) {
    return cleanString(
        flight?.depTimeAct ||
        flight?.depTime ||
        flight?.departureTime ||
        flight?.createdAt
    );
}

// ============================================================
// FLIGHT NUMBER
// ============================================================

function getFlightNumber(flight) {
    return cleanString(
        flight?.flightNumber
    );
}

// ============================================================
// SIMULATOR
// ============================================================

function getSimulator(flight) {
    return cleanString(
        flight?.simulator
    );
}

// ============================================================
// PENALTIES
// ============================================================

function getPenalties(flight) {
    return toNumber(
        flight?.result?.totals?.penalties
    );
}

// ============================================================
// REVENUE
// ============================================================

function getRevenue(flight) {
    return toNumber(
        flight?.result?.totals?.revenue
    );
}

// ============================================================
// BALANCE
// ============================================================

function getBalance(flight) {
    return toNumber(
        flight?.result?.totals?.balance
    );
}

// ============================================================
// STARS
// ============================================================
//
// FORMULA:
//
// Stars = actual flight minutes
//       + distance / 10
//       + rating
//
// Example Christian:
//
// 54
// + 279 / 10
// + 9.87
//
// = 91.77
//
// Example Paul:
//
// 855
// + 6486 / 10
// + 9.53
//
// = 1513.13
//
// Decimal values are preserved.
//
// ============================================================

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

function formatFlight(flight) {
    return {
        id:
            flight.id,

        newskyId:
            flight.newsky_id,

        flightNumber:
            flight.flight_number,

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

        simulator:
            flight.simulator,

        penalties:
            round(
                toNumber(
                    flight.penalties
                ),
                2
            ),

        revenue:
            round(
                toNumber(
                    flight.revenue
                ),
                2
            ),

        balance:
            round(
                toNumber(
                    flight.balance
                ),
                2
            ),

        syncedAt:
            flight.synced_at
    };
}

// ============================================================
// ACHIEVEMENTS
// ============================================================

function getAchievements(stats) {
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

function getUserStats(userId) {
    const flights =
        db.prepare(`
            SELECT *
            FROM flights
            WHERE user_id = ?
            ORDER BY
                datetime(dep_time) DESC,
                id DESC
        `).all(userId);

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

function createToken(user) {
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

                duration:
                    stats.duration,

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

function extractFlights(data) {
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

async function getNewSkyFlightPage(skip) {
    if (!process.env.NEWSKY_API_KEY) {
        throw new Error(
            "NEWSKY_API_KEY is not configured."
        );
    }

    const body = {
        skip,
        count: NEWSKY_PAGE_SIZE,
        includeDeleted: false
    };

    console.log(
        `NewSky request: skip=${skip}, count=${NEWSKY_PAGE_SIZE}`
    );

    const response = await fetch(
        NEWSKY_FLIGHTS_URL,
        {
            method: "POST",

            headers: {
                Authorization:
                    `Bearer ${process.env.NEWSKY_API_KEY}`,

                "Content-Type":
                    "application/json",

                Accept:
                    "application/json"
            },

            body:
                JSON.stringify(body)
        }
    );

    const text =
        await response.text();

    let data;

    try {
        data =
            JSON.parse(text);
    } catch {
        console.error(
            "NewSky returned non-JSON response:",
            text.substring(0, 1000)
        );

        throw new Error(
            "NewSky returned an invalid JSON response."
        );
    }

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
    extractFlights(data);

console.log(
    "NewSky raw response:",
    JSON.stringify(data, null, 2)
);

console.log(
    "NewSky response information:",
    {
        skip,

        requested:
            NEWSKY_PAGE_SIZE,

        received:
            flights.length,

        totalResults:
            data?.totalResults ?? null,

        topLevelKeys:
            data &&
            typeof data === "object" &&
            !Array.isArray(data)
                ? Object.keys(data)
                : [],

        pagination:
            data?.pagination ||
            data?.paging ||
            data?.meta ||
            null
    }
);

    return {
        data,
        flights
    };
}

// ============================================================
// GET ALL NEWSKY FLIGHTS
// ============================================================

async function getAllNewSkyFlights() {
    const allFlights = [];

    const seenIds =
        new Set();

    let skip = 0;

    let pagesFetched = 0;

    let duplicateFlightsIgnored = 0;

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
                duplicateFlightsIgnored++;
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

        if (
            flights.length <
            NEWSKY_PAGE_SIZE
        ) {
            console.log(
                "Last NewSky page reached."
            );

            break;
        }

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

        duplicateFlightsIgnored
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

function buildPilotLookup(pilots) {
    const lookup =
        new Map();

    for (
        const pilot
        of pilots
    ) {
        const pilotId =
            cleanString(
                pilot.newsky_pilot_id
            );

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
            flight_number,
            dep_icao,
            arr_icao,
            aircraft,
            rating,
            duration,
            distance,
            stars,
            dep_time,
            simulator,
            penalties,
            revenue,
            balance,
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
            ?,
            ?,
            ?,
            ?,
            ?,
            CURRENT_TIMESTAMP
        )

        ON CONFLICT(user_id, newsky_id)
        DO UPDATE SET

            flight_number =
                excluded.flight_number,

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

            simulator =
                excluded.simulator,

            penalties =
                excluded.penalties,

            revenue =
                excluded.revenue,

            balance =
                excluded.balance,

            synced_at =
                CURRENT_TIMESTAMP
    `);

// ============================================================
// PREPARE FLIGHT
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

    const flightNumber =
        getFlightNumber(
            flight
        );

    const simulator =
        getSimulator(
            flight
        );

    const penalties =
        getPenalties(
            flight
        );

    const revenue =
        getRevenue(
            flight
        );

    const balance =
        getBalance(
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

        flightNumber,

        departure:
            departure ||
            null,

        arrival:
            arrival ||
            null,

        aircraft:
            aircraft ||
            null,

        rating,

        duration,

        distance,

        stars,

        depTime:
            depTime ||
            null,

        simulator:
            simulator ||
            null,

        penalties,

        revenue,

        balance
    };
}

// ============================================================
// FULL ECHO AIR GROUP SYNC
// ============================================================

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
                duplicateFlightsIgnored
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

                                prepared.flightNumber,

                                prepared.departure,

                                prepared.arrival,

                                prepared.aircraft,

                                prepared.rating,

                                prepared.duration,

                                prepared.distance,

                                prepared.stars,

                                prepared.depTime,

                                prepared.simulator,

                                prepared.penalties,

                                prepared.revenue,

                                prepared.balance
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
                                stats.rank.name,

                            averageRating:
                                stats.averageRating,

                            distance:
                                stats.distance,

                            flightHours:
                                stats.flightHours
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

                duplicateFlightsIgnored,

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
// PERSONAL SYNC
// ============================================================

app.post(
    "/api/sync/me",
    authenticate,
    async (req, res) => {
        try {
            const pilotId =
                cleanString(
                    req.user.newsky_pilot_id
                );

            if (!pilotId) {
                return res.status(400).json({
                    error:
                        "Please link your NewSky Pilot ID first."
                });
            }

            const {
                flights,
                pagesFetched
            } =
                await getAllNewSkyFlights();

            const pilotFlights =
                flights.filter(
                    flight =>
                        getPilotId(
                            flight
                        ) === pilotId
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

                                prepared.flightNumber,

                                prepared.departure,

                                prepared.arrival,

                                prepared.aircraft,

                                prepared.rating,

                                prepared.duration,

                                prepared.distance,

                                prepared.stars,

                                prepared.depTime,

                                prepared.simulator,

                                prepared.penalties,

                                prepared.revenue,

                                prepared.balance
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

                pagesFetched,

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
                        stats.flightHours,

                    distance:
                        stats.distance,

                    rank:
                        stats.rank.name
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

                                distance:
                                    stats.distance,

                                flightHours:
                                    stats.flightHours,

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
// ADMIN DATABASE STATS
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
                        u.display_name,
                        u.newsky_pilot_id,
                        COUNT(f.id) AS flights,
                        COALESCE(
                            SUM(f.stars),
                            0
                        ) AS stars
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
            "================================================"
        );

        console.log(
            "Echo Air Group backend started"
        );

        console.log(
            `Port: ${PORT}`
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

        console.log(
            "================================================"
        );
    }
);
