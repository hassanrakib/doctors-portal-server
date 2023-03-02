const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();
const port = process.env.PORT || 5000;

const app = express();

// middleware
app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster-1.yey930g.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri);

// verify json web token that comes in headers of an api call
function verifyJWT(req, res, next) {
  const authorizationHeader = req.headers?.authorization;

  if (!authorizationHeader) {
    return res.status(401).send({ message: "Unauthorized Access" });
  }

  const token = authorizationHeader.split(" ")[1];

  // verify token
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, function (err, decoded) {
    if (err) {
      return res.status(403).send({ message: "Access Forbidden" });
    }
    // set the decoded information to the req object
    req.decoded = decoded;
    // call the next handler
    next();
  });
}

async function run() {
  try {
    // collections
    const appointmentOptions = client
      .db("doctors_Portal")
      .collection("appointment_Options");
    const bookings = client.db("doctors_Portal").collection("bookings");
    const users = client.db("doctors_Portal").collection("users");
    const doctors = client.db("doctors_Portal").collection("doctors");

    // use verifyAdmin middleware after verifyJWT to get the req.decoded object
    const verifyAdmin = async (req, res, next) => {
      const decodedEmail = req.decoded.email;
      const query = { email: decodedEmail };
      const currentLoggedInUser = await users.findOne(query);

      if (currentLoggedInUser.role !== "admin") {
        return res.status(403).send({ message: "Access Forbidden" });
      }

      // go to the next handler if the user is an admin
      next();
    };

    // get appointmentOptions
    app.get("/appointment-options", async (req, res) => {
      const date = req.query.date;
      const query = {};
      const cursor = appointmentOptions.find(query);
      const appointmentOptionsArr = await cursor.toArray();

      // get bookings by specific date
      const queryBookingsByDate = { appointmentDate: date };
      const bookingsByDate = await bookings.find(queryBookingsByDate).toArray();

      appointmentOptionsArr.forEach((appointmentOption) => {
        // get bookings of specific appointment option
        const bookingsByAppointmentOption = bookingsByDate.filter(
          (booking) => booking.treatment === appointmentOption.name
        );
        const bookedSlots = bookingsByAppointmentOption.map(
          (booking) => booking.slot
        );

        // remaining slots of the specific appointment option
        const remainingSlots = appointmentOption.slots.filter(
          (slot) => !bookedSlots.includes(slot)
        );

        // re assign the slots property of the specific appointment option
        appointmentOption.slots = remainingSlots;
      });

      res.send(appointmentOptionsArr);
    });

    // next version of the appointmentOptions api
    app.get("/v2/appointment-options", async (req, res) => {
      const date = req.query.date;

      const appointmentOptionsArr = await appointmentOptions
        .aggregate([
          {
            $lookup: {
              from: "bookings",
              localField: "name",
              foreignField: "treatment",
              pipeline: [
                {
                  $match: {
                    $expr: {
                      $eq: ["$appointmentDate", date],
                    },
                  },
                },
              ],
              as: "bookingsByAppointmentOption",
            },
          },
          {
            $project: {
              name: 1,
              slots: 1,
              price: 1,
              bookedSlots: {
                $map: {
                  input: "$bookingsByAppointmentOption",
                  as: "booking",
                  in: "$$booking.slot",
                },
              },
            },
          },
          {
            $project: {
              name: 1,
              price: 1,
              slots: {
                $setDifference: ["$slots", "$bookedSlots"],
              },
            },
          },
        ])
        .toArray();
      res.send(appointmentOptionsArr);
    });

    // temporary operation to update price field in appointmentOptions
    /* app.get("/temporary/add-price-field", async (req, res) => {
      const filter = {};
      const updateDoc = {
        $set: {
          price: 99,
        },
      };
      const result = await appointmentOptions.updateMany(filter, updateDoc);
      console.log(`Updated ${result.modifiedCount} documents`);
      res.send({modifiedCount: result.modifiedCount})
    }); */

    // get specialties
    app.get("/specialties", async (req, res) => {
      const query = {};
      const result = await appointmentOptions
        .find(query)
        .project({ name: 1 })
        .toArray();
      res.send(result);
    });

    // get bookings by query email
    app.get("/bookings", verifyJWT, async (req, res) => {
      const email = req.query.email;
      const decoded = req.decoded;
      if (decoded.email !== email) {
        return res.status(403).send({ message: "Access Forbidden" });
      }
      const query = { email };
      const result = await bookings.find(query).toArray();
      res.send(result);
    });

    // get a specif booking by id
    app.get("/bookings/:id", verifyJWT, async (req, res) => {
      const query = { _id: new ObjectId(req.params.id) };
      const result = await bookings.findOne(query);
      res.send(result);
    });

    // create new booking
    app.post("/bookings", async (req, res) => {
      const booking = req.body;
      // limit number of bookings for
      const query = {
        appointmentDate: booking.appointmentDate,
        email: booking.email,
        treatment: booking.treatment,
      };
      const bookingsArr = await bookings.find(query).toArray();
      if (bookingsArr.length) {
        return res.send({
          acknowledged: false,
          message: `Already have a booking for ${booking.treatment} in ${booking.appointmentDate}.`,
        });
      }
      const result = await bookings.insertOne(booking);
      res.send(result);
    });

    // create a PaymentIntent
    app.post("/create-payment-intent", verifyJWT, async (req, res) => {
      const booking = req.body;
      const amount = booking.price * 100; // stripe takes amount in cents

      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: "usd",
        payment_method_types: ["card"],
      });

      res.send({
        clientSecret: paymentIntent.client_secret,
      });
    });

    // get user information to sign a jwt token
    app.get("/jwt", async (req, res) => {
      const email = req.query.email;

      // check if the user exists in db
      const user = await users.findOne({ email });
      if (user) {
        const token = jwt.sign({ email }, process.env.ACCESS_TOKEN_SECRET, {
          expiresIn: "2 days",
        });
        return res.send({ accessToken: token });
      }

      // if user doesn't exist in db
      res.status(403).send({ accessToken: "" });
    });

    // get users
    app.get("/users", async (req, res) => {
      const query = {};
      const result = await users.find(query).toArray();
      res.send(result);
    });

    // save user to db
    app.post("/users", async (req, res) => {
      const user = req.body;
      const result = await users.insertOne(user);
      res.send(result);
    });

    // check if a user is admin
    app.get("/users/admin/:email", async (req, res) => {
      const email = req.params.email;
      const query = { email };

      const user = await users.findOne(query);
      res.send({ isAdmin: user?.role === "admin" });
    });

    // make a user admin
    // before that ensuring that the user with role admin only can make others admin
    app.put("/users/admin/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const filter = { _id: new ObjectId(req.params.id) };
      const options = { upsert: true };
      const updateDoc = {
        $set: {
          role: "admin",
        },
      };
      const result = await users.updateOne(filter, updateDoc, options);
      res.send(result);
    });

    // get doctors
    app.get("/doctors", verifyJWT, verifyAdmin, async (req, res) => {
      const query = {};
      const result = await doctors.find(query).toArray();
      res.send(result);
    });

    // add new doctor to doctors collection
    app.post("/doctors", verifyJWT, verifyAdmin, async (req, res) => {
      const newDoctor = req.body;
      const result = await doctors.insertOne(newDoctor);
      res.send(result);
    });

    // delete a doctor
    app.delete("/doctors/:id", verifyJWT, verifyAdmin, async (req, res) => {
      const query = { _id: new ObjectId(req.params.id) };
      const result = await doctors.deleteOne(query);
      res.send(result);
    });
  } finally {
    // await client.close();
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("doctors portal server");
});

app.listen(port, () => {
  console.log(`Server is running in port ${port}`);
});
