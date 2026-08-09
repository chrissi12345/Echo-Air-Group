const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

if (!process.env.NEWSKY_API_KEY) {
    console.error("ERROR: NEWSKY_API_KEY is missing from .env");
}

if (!JWT_SECRET) {
    console.error("ERROR: JWT_SECRET is missing from .env");
}


// ============================================================
// DATABASE
// ============================================================

const db = new Database("echo.db");

db.pragma("journal_mode = WAL");

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
        newsky_id TEXT UNIQUE NOT NULL,

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
    );
`);

console.log("Database ready.");


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
        stars: 2000
    },
    {
        name: "Captain",
        stars: 4000
    },
    {
        name: "Senior Captain",
        stars: 7000
    },
    {
        name: "Commander",
        stars: 10000
    }
];


function getRank(stars) {

    let current = RANKS[0];
    let next = null;

    for (const rank of RANKS) {

        if (stars >= rank.stars) {
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
// ACHIEVEMENTS
// ============================================================

function getAchievements(stats) {

    return [

        {
            id: "first-flight",
            name: "First Flight",
            description: "Complete your first flight.",
            icon: "🛫",
            unlocked: stats.flightCount >= 1
        },

        {
            id: "airborne",
            name: "Airborne",
            description: "Complete 10 flights.",
            icon: "✈️",
            unlocked: stats.flightCount >= 10
        },

        {
            id: "pilot",
            name: "Experienced Pilot",
            description: "Complete 50 flights.",
            icon: "👨‍✈️",
            unlocked: stats.flightCount >= 50
        },

        {
            id: "veteran",
            name: "Veteran Pilot",
            description: "Complete 100 flights.",
            icon: "🎖️",
            unlocked: stats.flightCount >= 100
        },

        {
            id: "globetrotter",
            name: "Globetrotter",
            description: "Fly 10,000 km.",
            icon: "🌍",
            unlocked: stats.distance >= 10000
        },

        {
            id: "world-traveler",
            name: "World Traveler",
            description: "Fly 50,000 km.",
            icon: "🌎",
            unlocked: stats.distance >= 50000
        },

        {
            id: "explorer",
            name: "Explorer",
            description: "Fly 100,000 km.",
            icon: "🧭",
            unlocked: stats.distance >= 100000
        },

        {
            id: "long-haul",
            name: "Long Hauler",
            description: "Fly 100 flight hours.",
            icon: "⏱️",
            unlocked: stats.flightHours >= 100
        },

        {
            id: "sky-master",
            name: "Sky Master",
            description: "Fly 250 flight hours.",
            icon: "☁️",
            unlocked: stats.flightHours >= 250
        },

        {
            id: "five-star",
            name: "Five Star Pilot",
            description: "Achieve an average rating of 5.00.",
            icon: "⭐",
            unlocked:
                stats.flightCount > 0 &&
                stats.averageRating >= 5
        },

        {
            id: "first-officer",
            name: "First Officer",
            description: "Reach 1,000 stars.",
            icon: "🥇",
            unlocked: stats.stars >= 1000
        },

        {
            id: "captain",
            name: "Captain",
            description: "Reach 4,000 stars.",
            icon: "🏆",
            unlocked: stats.stars >= 4000
        },

        {
            id: "senior-captain",
            name: "Senior Captain",
            description: "Reach 7,000 stars.",
            icon: "👑",
            unlocked: stats.stars >= 7000
        },

        {
            id: "commander",
            name: "Commander",
            description: "Reach 10,000 stars.",
            icon: "🚀",
            unlocked: stats.stars >= 10000
        }

    ];
}


// ============================================================
// AUTHENTICATION
// ============================================================

function createToken(user) {

    return jwt.sign(
        {
            id: user.id,
            username: user.username
        },
        JWT_SECRET,
        {
            expiresIn: "30d"
        }
    );
}


function authenticate(req, res, next) {

    const header =
        req.headers.authorization;

    if (
        !header ||
        !header.startsWith("Bearer ")
    ) {

        return res.status(401).json({
            error: "Authentication required"
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
            db.prepare(
                "SELECT * FROM users WHERE id = ?"
            ).get(decoded.id);

        if (!user) {

            return res.status(401).json({
                error: "User not found"
            });
        }

        req.user = user;

        next();

    } catch {

        return res.status(401).json({
            error: "Invalid or expired token"
        });
    }
}


// ============================================================
// TEST
// ============================================================

app.get("/", (req, res) => {

    res.json({
        message:
            "Echo Air Group backend is running!"
    });

});


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

            if (
                !username ||
                !password
            ) {

                return res.status(400).json({
                    error:
                        "Username and password are required"
                });
            }

            if (username.length < 3) {

                return res.status(400).json({
                    error:
                        "Username must be at least 3 characters"
                });
            }

            if (password.length < 8) {

                return res.status(400).json({
                    error:
                        "Password must be at least 8 characters"
                });
            }

            const existing =
                db.prepare(
                    "SELECT id FROM users WHERE username = ?"
                ).get(username);

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
                createToken(user);

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

            const {
                username,
                password
            } = req.body;

            const user =
                db.prepare(
                    "SELECT * FROM users WHERE username = ?"
                ).get(username);

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
                createToken(user);

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
// GET MY DASHBOARD
// ============================================================

app.get(
    "/api/me",
    authenticate,
    (req, res) => {

        const flights =
            db.prepare(`
                SELECT
                    *
                FROM flights
                WHERE user_id = ?
                ORDER BY
                    dep_time DESC
            `).all(req.user.id);


        const flightCount =
            flights.length;


        const stars =
            flights.reduce(
                (sum, flight) =>
                    sum +
                    Number(
                        flight.stars || 0
                    ),
                0
            );


        const distance =
            flights.reduce(
                (sum, flight) =>
                    sum +
                    Number(
                        flight.distance || 0
                    ),
                0
            );


        const duration =
            flights.reduce(
                (sum, flight) =>
                    sum +
                    Number(
                        flight.duration || 0
                    ),
                0
            );


        const averageRating =
            flightCount
                ? flights.reduce(
                    (sum, flight) =>
                        sum +
                        Number(
                            flight.rating || 0
                        ),
                    0
                ) / flightCount
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


        const stats = {

            stars:
                Math.round(
                    stars * 100
                ) / 100,

            rank:
                rankData.current.name,

            rankMin:
                rankData.current.stars,

            nextRank:
                rankData.next,

            progress:
                Math.round(
                    progress * 10
                ) / 10,

            flightCount,

            distance:
                Math.round(
                    distance * 100
                ) / 100,

            flightHours:
                Math.round(
                    flightHours * 10
                ) / 10,

            averageRating:
                Math.round(
                    averageRating * 100
                ) / 100

        };


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
                    req.user.newsky_pilot_id

            },

            stats,

            achievements:
                getAchievements(stats),

            flights:
                flights
                    .slice(0, 25)
                    .map(formatFlight)

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

        const {
            newskyPilotId
        } = req.body;


        const cleanId =
            String(
                newskyPilotId || ""
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
// NEWSKY API
// ============================================================

async function getNewSkyFlights() {

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

                        skip: 0,

                        count: 100,

                        includeDeleted:
                            false

                    })

            }
        );


    if (!response.ok) {

        const errorText =
            await response.text();

        throw new Error(
            `NewSky API ${response.status}: ${errorText}`
        );
    }


    return response.json();
}


// ============================================================
// HELPER FUNCTIONS FOR NEWSKY DATA
// ============================================================

function firstValue(...values) {

    for (const value of values) {

        if (
            value !== undefined &&
            value !== null &&
            value !== ""
        ) {
            return value;
        }
    }

    return null;
}


function getDeparture(flight) {

    return (
        flight.departure ||
        flight.dep ||
        flight.from ||
        {}
    );
}


function getArrival(flight) {

    return (
        flight.arrival ||
        flight.arr ||
        flight.to ||
        {}
    );
}


function getTotals(flight) {

    return (
        flight.result?.totals ||
        flight.totals ||
        {}
    );
}


function getDepartureIcao(flight) {

    const departure =
        getDeparture(flight);


    return String(
        firstValue(

            flight.depIcao,

            flight.departureIcao,

            flight.depICAO,

            departure.icao,

            departure.ICAO,

            departure.code,

            departure.airport?.icao,

            departure.airport?.ICAO

        ) || ""
    ).trim().toUpperCase();
}


function getArrivalIcao(flight) {

    const arrival =
        getArrival(flight);


    return String(
        firstValue(

            flight.arrIcao,

            flight.arrivalIcao,

            flight.arrICAO,

            arrival.icao,

            arrival.ICAO,

            arrival.code,

            arrival.airport?.icao,

            arrival.airport?.ICAO

        ) || ""
    ).trim().toUpperCase();
}


function getAircraftName(flight) {

    return String(
        firstValue(

            flight.aircraft?.name,

            flight.aircraft?.airframe?.name,

            flight.aircraft?.airframe,

            flight.aircraft?.icao,

            flight.aircraft?.type,

            flight.aircraftName,

            flight.aircraft

        ) || "Unknown"
    );
}


function getFlightDate(flight) {

    return firstValue(

        flight.depTimeAct,

        flight.depTime,

        flight.departureTime,

        flight.departure?.time,

        flight.startedAt,

        flight.startTime,

        flight.createdAt,

        flight.date

    );
}


function getFlightDuration(flight) {

    const totals =
        getTotals(flight);


    let duration =
        Number(
            firstValue(

                totals.time,

                flight.duration,

                flight.flightTime,

                flight.flightDuration,

                0

            ) || 0
        );


    /*
     * Echo gebruikt minuten.
     *
     * Als NewSky seconden terugstuurt,
     * converteren we naar minuten.
     */

    if (duration > 10000) {

        duration =
            duration / 60;

    }


    return duration;
}


function getFlightDistance(flight) {

    const totals =
        getTotals(flight);


    return Number(
        firstValue(

            totals.distance,

            flight.distance,

            flight.flightDistance,

            0

        ) || 0
    );
}


function getFlightRating(flight) {

    const result =
        flight.result ||
        {};


    return Number(
        firstValue(

            flight.rating,

            result.rating,

            result.score,

            0

        ) || 0
    );
}


// ============================================================
// NORMALIZE NEWSKY FLIGHT
// ============================================================

function normalizeNewSkyFlight(flight) {

    const depIcao =
        getDepartureIcao(flight);

    const arrIcao =
        getArrivalIcao(flight);

    const aircraft =
        getAircraftName(flight);

    const depTime =
        getFlightDate(flight);

    const duration =
        getFlightDuration(flight);

    const distance =
        getFlightDistance(flight);

    const rating =
        getFlightRating(flight);


    /*
     * Echo Air Group stars:
     *
     * flight time
     * +
     * distance / 10
     * +
     * rating
     */

    const stars =
        duration +
        (distance / 10) +
        rating;


    const flightId =
        firstValue(

            flight._id,

            flight.id,

            flight.flightId,

            flight.flight?._id,

            flight.flight?.id

        ) ||
        `${flight.pilot?._id || "unknown"}-${depTime || Date.now()}-${depIcao}-${arrIcao}`;


    return {

        newskyId:
            String(flightId),

        depIcao,

        arrIcao,

        aircraft,

        rating,

        duration,

        distance,

        stars:
            Math.round(
                stars * 100
            ) / 100,

        depTime

    };
}


// ============================================================
// FORMAT DATABASE FLIGHT
// ============================================================

function formatFlight(flight) {

    const route =
        flight.dep_icao &&
        flight.arr_icao

            ? `${flight.dep_icao} → ${flight.arr_icao}`

            : "Unknown route";


    return {

        id:
            flight.id,

        newskyId:
            flight.newsky_id,

        date:
            flight.dep_time,

        depTime:
            flight.dep_time,

        dep_time:
            flight.dep_time,

        departure:
            flight.dep_icao || null,

        arrival:
            flight.arr_icao || null,

        depIcao:
            flight.dep_icao || null,

        arrIcao:
            flight.arr_icao || null,

        dep_icao:
            flight.dep_icao || null,

        arr_icao:
            flight.arr_icao || null,

        route,

        aircraft:
            flight.aircraft || "Unknown",

        rating:
            Number(
                flight.rating || 0
            ),

        stars:
            Number(
                flight.stars || 0
            ),

        distance:
            Number(
                flight.distance || 0
            ),

        duration:
            Number(
                flight.duration || 0
            )

    };
}


// ============================================================
// SYNC MY FLIGHTS
// ============================================================

app.post(
    "/api/sync/me",
    authenticate,
    async (req, res) => {

        try {

            if (!req.user.newsky_pilot_id) {

                return res.status(400).json({

                    error:
                        "Link your NewSky Pilot ID first."

                });
            }


            const data =
                await getNewSkyFlights();


            const flights =
                Array.isArray(data)
                    ? data
                    : data.results || [];


            const myFlights =
                flights.filter(
                    flight => {

                        const pilotId =
                            firstValue(

                                flight.pilot?._id,

                                flight.pilot?.id,

                                flight.pilotId,

                                flight.pilot?._id?.toString()

                            );


                        return String(
                            pilotId || ""
                        ) === String(
                            req.user.newsky_pilot_id
                        );

                    }
                );


            console.log(
                `Found ${myFlights.length} NewSky flight(s) for pilot ${req.user.newsky_pilot_id}`
            );


            const insertFlight =
                db.prepare(`

                    INSERT OR REPLACE INTO flights

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
                        dep_time
                    )

                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)

                `);


            const transaction =
                db.transaction(
                    flightList => {

                        for (
                            const rawFlight
                            of flightList
                        ) {

                            const flight =
                                normalizeNewSkyFlight(
                                    rawFlight
                                );


                            console.log(
                                "Saving flight:",
                                {
                                    id:
                                        flight.newskyId,

                                    route:
                                        `${flight.depIcao} → ${flight.arrIcao}`,

                                    date:
                                        flight.depTime,

                                    aircraft:
                                        flight.aircraft,

                                    duration:
                                        flight.duration,

                                    distance:
                                        flight.distance,

                                    rating:
                                        flight.rating,

                                    stars:
                                        flight.stars
                                }
                            );


                            insertFlight.run(

                                req.user.id,

                                flight.newskyId,

                                flight.depIcao,

                                flight.arrIcao,

                                flight.aircraft,

                                flight.rating,

                                flight.duration,

                                flight.distance,

                                flight.stars,

                                flight.depTime

                            );

                        }

                    }
                );


            transaction(myFlights);


            res.json({

                message:
                    `${myFlights.length} flight(s) synchronized.`,

                flights:
                    myFlights.length

            });


        } catch (error) {

            console.error(
                "Sync error:",
                error
            );


            res.status(500).json({

                error:
                    "Could not synchronize NewSky flights",

                details:
                    error.message

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

            const pilots =
                db.prepare(`

                    SELECT
                        u.id,
                        u.username,
                        u.display_name,

                        COUNT(f.id) AS flights,

                        COALESCE(
                            SUM(f.stars),
                            0
                        ) AS stars

                    FROM users u

                    LEFT JOIN flights f
                        ON f.user_id = u.id

                    GROUP BY u.id

                    ORDER BY stars DESC

                `).all();


            const rankings =
                pilots.map(
                    (pilot, index) => {

                        const stars =
                            Number(
                                pilot.stars || 0
                            );


                        const rank =
                            getRank(stars);


                        return {

                            position:
                                index + 1,

                            id:
                                pilot.id,

                            name:
                                pilot.display_name ||
                                pilot.username,

                            rank:
                                rank.current.name,

                            stars:
                                Math.round(
                                    stars * 100
                                ) / 100,

                            flights:
                                Number(
                                    pilot.flights || 0
                                )

                        };

                    }
                );


            res.json({

                totalPilots:
                    rankings.length,

                rankings

            });


        } catch (error) {

            console.error(
                "Ranking error:",
                error
            );


            res.status(500).json({

                error:
                    "Could not create ranking"

            });

        }

    }
);


// ============================================================
// PILOT STATISTICS
// ============================================================

function getPilotStats(userId) {

    const flights =
        db.prepare(`
            SELECT
                *
            FROM flights
            WHERE user_id = ?
            ORDER BY
                dep_time DESC
        `).all(userId);


    const flightCount =
        flights.length;


    const stars =
        flights.reduce(
            (sum, flight) =>
                sum +
                Number(
                    flight.stars || 0
                ),
            0
        );


    const distance =
        flights.reduce(
            (sum, flight) =>
                sum +
                Number(
                    flight.distance || 0
                ),
            0
        );


    const duration =
        flights.reduce(
            (sum, flight) =>
                sum +
                Number(
                    flight.duration || 0
                ),
            0
        );


    const totalRating =
        flights.reduce(
            (sum, flight) =>
                sum +
                Number(
                    flight.rating || 0
                ),
            0
        );


    const averageRating =
        flightCount
            ? totalRating / flightCount
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


    const stats = {

        stars:
            Math.round(
                stars * 100
            ) / 100,

        rank:
            rankData.current.name,

        rankMin:
            rankData.current.stars,

        nextRank:
            rankData.next,

        progress:
            Math.round(
                progress * 10
            ) / 10,

        flightCount,

        distance:
            Math.round(
                distance * 100
            ) / 100,

        flightHours:
            Math.round(
                flightHours * 10
            ) / 10,

        averageRating:
            Math.round(
                averageRating * 100
            ) / 100

    };


    return {

        stats,

        achievements:
            getAchievements(stats),

        flights

    };

}


// ============================================================
// GET ALL PUBLIC PILOTS
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

                    ORDER BY id ASC

                `).all();


            const pilots =
                users.map(
                    user => {

                        const career =
                            getPilotStats(
                                user.id
                            );


                        return {

                            id:
                                user.id,

                            username:
                                user.username,

                            name:
                                user.display_name ||
                                user.username,

                            memberSince:
                                user.created_at,

                            linked:
                                Boolean(
                                    user.newsky_pilot_id
                                ),

                            rank:
                                career.stats.rank,

                            stars:
                                career.stats.stars,

                            flights:
                                career.stats.flightCount,

                            distance:
                                career.stats.distance,

                            flightHours:
                                career.stats.flightHours,

                            averageRating:
                                career.stats.averageRating,

                            achievementCount:
                                career.achievements.filter(
                                    achievement =>
                                        achievement.unlocked
                                ).length

                        };

                    }
                );


            pilots.sort(
                (a, b) =>
                    b.stars - a.stars
            );


            pilots.forEach(
                (pilot, index) => {

                    pilot.position =
                        index + 1;

                }
            );


            res.json({

                totalPilots:
                    pilots.length,

                pilots

            });


        } catch (error) {

            console.error(
                "Pilot list error:",
                error
            );


            res.status(500).json({

                error:
                    "Could not load pilots"

            });

        }

    }
);


// ============================================================
// GET SINGLE PUBLIC PILOT PROFILE
// ============================================================

app.get(
    "/api/pilots/:id",
    (req, res) => {

        try {

            const pilotId =
                Number(
                    req.params.id
                );


            if (
                !Number.isInteger(
                    pilotId
                )
            ) {

                return res.status(400).json({

                    error:
                        "Invalid pilot ID"

                });

            }


            const user =
                db.prepare(`

                    SELECT
                        id,
                        username,
                        display_name,
                        newsky_pilot_id,
                        created_at

                    FROM users

                    WHERE id = ?

                `).get(pilotId);


            if (!user) {

                return res.status(404).json({

                    error:
                        "Pilot not found"

                });

            }


            const career =
                getPilotStats(
                    user.id
                );


            const stats =
                career.stats;


            const achievements =
                career.achievements;


            const flights =
                career.flights
                    .slice(0, 25)
                    .map(formatFlight);


            const unlockedAchievements =
                achievements.filter(
                    achievement =>
                        achievement.unlocked
                ).length;


            res.json({

                pilot: {

                    id:
                        user.id,

                    username:
                        user.username,

                    name:
                        user.display_name ||
                        user.username,

                    memberSince:
                        user.created_at

                },


                stats: {

                    stars:
                        stats.stars,

                    rank:
                        stats.rank,

                    rankMin:
                        stats.rankMin,

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


                achievements: {

                    unlocked:
                        unlockedAchievements,

                    total:
                        achievements.length,

                    list:
                        achievements

                },


                flights

            });

        } catch (error) {

            console.error(
                "Pilot profile error:",
                error
            );


            res.status(500).json({

                error:
                    "Could not load pilot profile"

            });

        }

    }
);


// ============================================================
// START SERVER
// ============================================================

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            `Echo Air Group backend running on port ${PORT}`
        );

    }
);
