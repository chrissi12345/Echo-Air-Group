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
// ENVIRONMENT CHECK
// ============================================================

if (!process.env.NEWSKY_API_KEY) {
    console.warn(
        "WARNING: NEWSKY_API_KEY is missing."
    );
}

if (!process.env.JWT_SECRET) {
    console.warn(
        "WARNING: JWT_SECRET is missing. Set it in Render/environment variables."
    );
}


// ============================================================
// DATABASE
// ============================================================

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");


// ============================================================
// DATABASE TABLES
// ============================================================

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
// DATABASE MIGRATION
// ============================================================
//
// This makes the backend safer when an older echo.db already
// exists from a previous version.
//

function columnExists(table, column) {

    const columns =
        db.prepare(
            `PRAGMA table_info(${table})`
        ).all();

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
        "The flights table does not contain user_id. Database migration is required."
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
// NUMBER HELPERS
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
        Math.pow(10, decimals);

    return Math.round(
        value * factor
    ) / factor;

}


// ============================================================
// VALUE HELPERS
// ============================================================

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
// NEW SKY PILOT ID
// ============================================================
//
// NewSky's API response can change shape, so this supports
// several possible field names.
//

function getPilotId(flight) {

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

        return String(direct).trim();

    }


    if (
        flight.pilot &&
        typeof flight.pilot === "object"
    ) {

        const nested =
            firstValue(
                flight.pilot,
                [
                    "id",
                    "pilotId",
                    "pilotID",
                    "newskyPilotId"
                ]
            );


        if (nested !== null) {

            return String(nested).trim();

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
                    "id",
                    "pilotId",
                    "pilotID"
                ]
            );


        if (nested !== null) {

            return String(nested).trim();

        }

    }


    return "";

}


// ============================================================
// NEW SKY FLIGHT ID
// ============================================================

function getNewSkyFlightId(flight) {

    const value =
        firstValue(
            flight,
            [
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


    return String(value);

}


// ============================================================
// ROUTE
// ============================================================

function getDeparture(flight) {

    return firstValue(
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

}


function getArrival(flight) {

    return firstValue(
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


    return aircraft || "Unknown aircraft";

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


    return toNumber(rating);

}


// ============================================================
// DURATION
// ============================================================
//
// We want minutes.
//

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


    return toNumber(value);

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


    return toNumber(value);

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
// STAR CALCULATION
// ============================================================
//
// Echo Air Group formula:
//
// Stars = flown minutes
//       + distance / 10
//       + rating bonus
//
// Rating bonus = rating.
//
// Example:
//
// 54 minutes
// + 120 km / 10
// + 9.50 rating
//
// = 75.50 stars
//
// Stars are deliberately NOT rounded to whole numbers.
//

function calculateFlightStars(
    duration,
    distance,
    rating
) {

    const minutes =
        toNumber(duration);

    const km =
        toNumber(distance);

    const flightRating =
        toNumber(rating);


    const ratingBonus =
        flightRating;


    return round(
        minutes +
        (km / 10) +
        ratingBonus,
        2
    );

}


// ============================================================
// FLIGHT FORMAT
// ============================================================

function formatFlight(flight) {

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
                toNumber(flight.rating),
                2
            ),

        duration:
            round(
                toNumber(flight.duration),
                2
            ),

        distance:
            round(
                toNumber(flight.distance),
                2
            ),

        stars:
            round(
                toNumber(flight.stars),
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
//
// VERY IMPORTANT:
//
// This function ALWAYS receives a specific user ID.
//
// Therefore it can NEVER accidentally calculate statistics
// using another pilot's flights.
//

function getUserStats(userId) {

    const flights =
        db.prepare(`
            SELECT
                *
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
            ) => {

                return total +
                    toNumber(
                        flight.stars
                    );

            },
            0
        );


    const distance =
        flights.reduce(
            (
                total,
                flight
            ) => {

                return total +
                    toNumber(
                        flight.distance
                    );

            },
            0
        );


    const duration =
        flights.reduce(
            (
                total,
                flight
            ) => {

                return total +
                    toNumber(
                        flight.duration
                    );

            },
            0
        );


    const ratingTotal =
        flights.reduce(
            (
                total,
                flight
            ) => {

                return total +
                    toNumber(
                        flight.rating
                    );

            },
            0
        );


    const averageRating =
        flightCount > 0
            ? ratingTotal / flightCount
            : 0;


    const flightHours =
        duration / 60;


    const rankData =
        getRank(stars);


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
            round(stars, 2),

        distance:
            round(distance, 2),

        duration:
            round(duration, 2),

        flightHours:
            round(flightHours, 1),

        averageRating:
            round(averageRating, 2),

        rank:
            rankData.current,

        nextRank:
            rankData.next,

        progress:
            round(progress, 1)

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
        !header.startsWith("Bearer ")
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

    } catch {

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
// HEALTH CHECK
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
// GET MY PROFILE
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
                getAchievements({

                    stars:
                        stats.stars,

                    flightCount:
                        stats.flightCount,

                    distance:
                        stats.distance,

                    flightHours:
                        stats.flightHours,

                    averageRating:
                        stats.averageRating

                }),


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
                req.body.newskyPilotId || ""
            ).trim();


        if (!cleanId) {

            return res.status(400).json({

                error:
                    "NewSky Pilot ID is required"

            });

        }


        db.prepare(`
            UPDATE users

            SET
                newsky_pilot_id = ?

            WHERE
                id = ?
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
// NEWSKY API REQUEST
// ============================================================

async function getNewSkyFlights() {

    if (!process.env.NEWSKY_API_KEY) {

        throw new Error(
            "NEWSKY_API_KEY is not configured."
        );

    }


    const response =
        await fetch(
            "https://newsky.app/api/airline-api/flights/recent",
            {

                method:
                    "POST",

                headers: {

                    "Authorization":
                        `Bearer ${process.env.NEWSKY_API_KEY}`,

                    "Content-Type":
                        "application/json"

                },

                body:
                    JSON.stringify({

                        skip:
                            0,

                        count:
                            100,

                        includeDeleted:
                            false

                    })

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
            "NewSky returned an invalid response."
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


    return data;

}


// ============================================================
// EXTRACT FLIGHTS FROM NEWSKY RESPONSE
// ============================================================

function extractFlights(data) {

    if (
        Array.isArray(data)
    ) {

        return data;

    }


    if (
        data &&
        Array.isArray(data.flights)
    ) {

        return data.flights;

    }


    if (
        data &&
        data.data &&
        Array.isArray(data.data)
    ) {

        return data.data;

    }


    if (
        data &&
        data.data &&
        Array.isArray(data.data.flights)
    ) {

        return data.data.flights;

    }


    if (
        data &&
        data.results &&
        Array.isArray(data.results)
    ) {

        return data.results;

    }


    return [];

}


// ============================================================
// CHECK WHETHER A NEWSKY FLIGHT BELONGS TO A PILOT
// ============================================================
//
// THIS IS ONE OF THE MOST IMPORTANT PARTS.
//
// We NEVER simply save every flight returned by NewSky.
//
// We first check its pilot ID against the logged-in user's
// linked NewSky Pilot ID.
//

function flightBelongsToPilot(
    flight,
    pilotId
) {

    const flightPilotId =
        getPilotId(
            flight
        );


    if (!flightPilotId) {

        return false;

    }


    return (
        String(
            flightPilotId
        ).trim() ===
        String(
            pilotId
        ).trim()
    );

}


// ============================================================
// SYNC MY FLIGHTS
// ============================================================

app.post(
    "/api/sync/me",
    authenticate,
    async (req, res) => {

        try {

            const pilotId =
                String(
                    req.user.newsky_pilot_id || ""
                ).trim();


            if (!pilotId) {

                return res.status(400).json({

                    error:
                        "Please link your NewSky Pilot ID first."

                });

            }


            const data =
                await getNewSkyFlights();


            const allFlights =
                extractFlights(
                    data
                );


            /*
             * CRITICAL:
             *
             * Only flights belonging to this exact
             * NewSky Pilot ID are allowed through.
             */

            const pilotFlights =
                allFlights.filter(
                    flight =>
                        flightBelongsToPilot(
                            flight,
                            pilotId
                        )
                );


            if (
                allFlights.length > 0 &&
                pilotFlights.length === 0
            ) {

                console.warn(

                    `No NewSky flights matched Pilot ID ${pilotId}.`

                );

            }


            const insert =
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


            let imported =
                0;

            let skipped =
                0;


            const transaction =
                db.transaction(
                    flights => {

                        for (
                            const flight
                            of flights
                        ) {

                            const newskyId =
                                getNewSkyFlightId(
                                    flight
                                );


                            if (!newskyId) {

                                skipped++;

                                continue;

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


                            insert.run(

                                req.user.id,

                                newskyId,

                                departure
                                    ? String(
                                        departure
                                    )
                                    : null,

                                arrival
                                    ? String(
                                        arrival
                                    )
                                    : null,

                                aircraft
                                    ? String(
                                        aircraft
                                    )
                                    : null,

                                rating,

                                duration,

                                distance,

                                stars,

                                depTime
                                    ? String(
                                        depTime
                                    )
                                    : null

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
                    "Flights synchronized successfully.",

                newskyFlightsReceived:
                    allFlights.length,

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
                "Sync error:",
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
//
// GET /api/pilots
//
// Returns EVERY registered Echo pilot.
//
// Each pilot gets statistics based ONLY on flights where:
//
// flights.user_id = users.id
//
// Therefore pilot A's flights can never appear in pilot B's
// statistics.
//

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
//
// Used when someone clicks a pilot in the sidebar.
//
// This endpoint intentionally does NOT return the password
// or NewSky Pilot ID.
//

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
//
// This is also calculated separately per user.
//
// No combined flight pool is used.
//

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
// DEBUG: CURRENT DATABASE STATS
// ============================================================
//
// Useful while developing.
//
// Does NOT expose passwords.
//

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

    }
);
